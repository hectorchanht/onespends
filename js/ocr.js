// OneSpends — on-device receipt OCR. Three engines, all fully local:
//
//   1. Chrome TextDetector (Shape Detection API) — uses the device's
//      built-in text detection: instant, ZERO download. Only exists in
//      Chromium browsers that expose window.TextDetector.
//   2. Tesseract.js 5.1.1, fully vendored under /vendor/tesseract/ —
//      no CDN is involved: the engine scripts load from this site, and
//      the worker fetches the core WASM build and language data from
//      the same origin, where the service worker caches them on first
//      use, so after the first Tesseract scan it works offline too.
//   3. PP-OCRv5 (tier 3), vendored under /vendor/ppocr/ — the most
//      accurate engine for Traditional-Chinese receipts (benchmark:
//      ~/workspace/onespends-benchmark/REPORT.md). Its models are
//      22.47 MB, downloaded only when PP-OCR actually runs (engine
//      "ppocr", or the in-dialog 重試 escalation the UI offers when an
//      Auto scan's parse is missing amount/date) and SW-cached after.
//
// Either way the receipt image itself never leaves the device.
//
// Engine choice (localStorage "onespends_ocr_engine", owner decision):
//   "ppocr" (DEFAULT) — always PP-OCRv5 (js/ppocr.js); the first scan
//     downloads its ~34 MB payload once, then it runs fully offline.
//   "auto"           — TextDetector when available, else Tesseract,
//     with the PP-OCRv5 escalation offered when a parse is incomplete.
//   "textdetector"   — prefer TextDetector; if detection is missing,
//     throws, or finds no text, fall back to Tesseract (never fail the
//     scan just because the preferred engine couldn't read it).
//   "tesseract"      — always Tesseract.
// The "ppocr" default applies only when the stored value is unset or
// invalid; an explicitly stored choice is always honoured as-is.
//
// Language quality (localStorage "onespends_ocr_quality"):
//   "best" (DEFAULT) — tessdata_best LSTM-only models in lang-best/.
//     The combined "best" tessdata previously couldn't ship (chi_tra
//     gz 26,951,501 B > the 25 MB Cloudflare Pages per-file limit), but
//     the LSTM-only tessdata_best files are far smaller: chi_tra gz
//     11,929,931 B, eng gz 12,813,244 B. Tesseract.js here runs the
//     LSTM engine (OEM 1), so LSTM-only models are all it needs.
//   "fast" — the original tessdata_fast models in lang/ (chi_tra gz
//     1,663,228 B, eng gz 1,976,309 B); smaller download, lower quality.
// The settings UI (in js/app.js) owns the pickers; this module exposes
// the mechanism via window.OneSpendsOcr.

const TESS_BASE = new URL("../vendor/tesseract/", import.meta.url);
const MAIN_SCRIPT = new URL("tesseract.min.js", TESS_BASE).href;
const WORKER_PATH = new URL("worker.min.js", TESS_BASE).href;
// Directory form: the worker picks the SIMD / LSTM core build itself.
const CORE_PATH = TESS_BASE.href;
const LANG_PATHS = {
  best: new URL("lang-best", TESS_BASE).href,
  fast: new URL("lang", TESS_BASE).href,
};

// Real bytes a first Tesseract scan downloads (main script 66,695 +
// worker 123,724 + simd-lstm core build 3,938,657 = 4,129,076 fixed,
// plus the two language files of the set): best = 28,872,251 ≈ 29 MB,
// fast = 7,768,613 ≈ 8 MB. Live binding: setQuality() updates
// OCR_DOWNLOAD_MB, so a later `await import("./ocr.js")` destructure
// reads the new figure.
const DOWNLOAD_MB = { best: 29, fast: 8 };
export const OCR_DOWNLOAD_MB_BY_QUALITY = { ...DOWNLOAD_MB };

const QUALITY_KEY = "onespends_ocr_quality";
export function getQuality() {
  try {
    return localStorage.getItem(QUALITY_KEY) === "fast" ? "fast" : "best";
  } catch {
    return "best";
  }
}
export let OCR_DOWNLOAD_MB = DOWNLOAD_MB[getQuality()];

const readyKey = (q) => `onespends_ocr_ready_${q}`;
export const isOcrReady = () => {
  try { return localStorage.getItem(readyKey(getQuality())) === "1"; } catch { return false; }
};
const markOcrReady = () => {
  try { localStorage.setItem(readyKey(getQuality()), "1"); } catch { /* private mode */ }
};

// ----- engine choice -----
const ENGINE_KEY = "onespends_ocr_engine";
const ENGINES = ["auto", "textdetector", "tesseract", "ppocr"];
const DEFAULT_ENGINE = "ppocr";
export function getEngine() {
  try {
    const v = localStorage.getItem(ENGINE_KEY);
    return ENGINES.includes(v) ? v : DEFAULT_ENGINE;
  } catch {
    return DEFAULT_ENGINE;
  }
}
export function setEngine(e) {
  try {
    localStorage.setItem(ENGINE_KEY, ENGINES.includes(e) ? e : DEFAULT_ENGINE);
  } catch { /* private mode */ }
}
export const isTextDetectorSupported = () =>
  typeof window !== "undefined" && "TextDetector" in window;

let loadPromise = null;
let liveWorker = null;

function loadScript() {
  if (window.Tesseract) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = MAIN_SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("OCR 引擎載入失敗 — 手動入數仍然可用。"));
    document.head.appendChild(s);
  });
  return loadPromise;
}

/**
 * Switch the language-quality set. Persists the choice and terminates
 * any live worker so the next scan rebuilds with the new langPath.
 * Returns a promise that settles when the old worker is gone.
 */
export function setQuality(q) {
  const next = q === "fast" ? "fast" : "best";
  try { localStorage.setItem(QUALITY_KEY, next); } catch { /* private mode */ }
  OCR_DOWNLOAD_MB = DOWNLOAD_MB[next];
  const worker = liveWorker;
  liveWorker = null;
  return worker ? worker.terminate().catch(() => {}) : Promise.resolve();
}

// ----- PP-OCRv5 (tier 3) -----
// js/ppocr.js is lazy-loaded only when PP-OCR runs. The models alone
// are 22.47 MB (det 4.82 + rec 16.63 + cls 1.02), but the real
// first-use payload also includes the onnxruntime-web runtime
// (ort-wasm-simd-threaded.wasm 11.25 MB + JS/glue ~0.07 MB) and the
// dictionary — 33,863,078 bytes in total. The figure shown to users
// before the first PP run is that whole payload, rounded up.
export const PPOCR_DOWNLOAD_MB = 34;
export const isPpocrReady = () => {
  try { return localStorage.getItem("onespends_ppocr_ready") === "1"; } catch { return false; }
};

async function runPpocr(file, onProgress, hooks) {
  if (!isPpocrReady() && hooks && typeof hooks.onDownload === "function") {
    hooks.onDownload(PPOCR_DOWNLOAD_MB);
  }
  const { recognizeReceiptImage } = await import("./ppocr.js");
  return recognizeReceiptImage(file, onProgress);
}

// Direct PP-OCRv5 entry point (engine "ppocr" scans + the in-dialog
// escalation retry in js/app.js). Returns raw OCR text.
export async function ocrWithPpocr(file, onProgress) {
  return runPpocr(file, onProgress, {});
}

// API for the OCR settings UI in js/app.js.
if (typeof window !== "undefined") {
  window.OneSpendsOcr = {
    getQuality, setQuality,
    getEngine, setEngine,
    isTextDetectorSupported,
    isPpocrReady,
    OCR_DOWNLOAD_MB_BY_QUALITY,
    PPOCR_DOWNLOAD_MB,
  };
}

// ----- Chrome TextDetector -----
// Detected blocks are ~lines with bounding boxes. Cluster them into
// visual rows (blocks whose tops sit within ~half a line height share
// a row), order each row left→right, and join rows with newlines so
// the result reads like receipt text for the parser.
function blocksToText(blocks) {
  const items = [];
  for (const b of blocks || []) {
    const text = (b.rawValue || "").trim();
    if (!text) continue;
    const box = b.boundingBox || {};
    items.push({ text, x: box.x || 0, y: box.y || 0, h: box.height || 0 });
  }
  items.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(it.y - row.y) <= Math.max(10, row.h * 0.6)) {
      row.items.push(it);
      row.y = Math.min(row.y, it.y);
      row.h = Math.max(row.h, it.h);
    } else {
      rows.push({ y: it.y, h: it.h, items: [it] });
    }
  }
  return rows
    .map((r) => r.items.sort((a, b) => a.x - b.x).map((i) => i.text).join(" "))
    .join("\n");
}

async function ocrWithTextDetector(file, onProgress) {
  const detector = new window.TextDetector();
  const bitmap = await createImageBitmap(file);
  try {
    if (onProgress) onProgress(50);
    const blocks = await detector.detect(bitmap);
    if (onProgress) onProgress(100);
    return blocksToText(blocks);
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}

// ----- Tesseract -----
async function runTesseract(file, onProgress, hooks) {
  // The first-scan download note belongs to the moment Tesseract
  // actually runs — a TextDetector scan must never trigger it.
  if (!isOcrReady() && hooks && typeof hooks.onDownload === "function") {
    hooks.onDownload(OCR_DOWNLOAD_MB);
  }
  await loadScript();
  const worker = await window.Tesseract.createWorker(["chi_tra", "eng"], 1, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_PATHS[getQuality()],
    logger: (m) => {
      if (m.status === "recognizing text" && onProgress) {
        onProgress(Math.round((m.progress || 0) * 100));
      }
    },
  });
  liveWorker = worker;
  markOcrReady();
  try {
    const { data } = await worker.recognize(file);
    return data.text || "";
  } finally {
    if (liveWorker === worker) liveWorker = null;
    await worker.terminate();
  }
}

/**
 * Recognize a receipt image file entirely on-device, honouring the
 * engine setting. Returns raw OCR text.
 * onProgress(0..100) — progress percent (Tesseract recognition only;
 * TextDetector reports 50 → 100 around its single detect call).
 * hooks.onDownload(mb) — called just before a first-time Tesseract
 * download starts, so the UI can show the first-scan note only then.
 * hooks.onEngine({ engine, fellBack }) — called once with the engine
 * that actually produced the returned text ("textdetector" |
 * "tesseract" | "ppocr"); fellBack is true when a TextDetector attempt
 * produced nothing usable and Tesseract took over.
 */
export async function ocrImage(file, onProgress, hooks = {}) {
  const engine = getEngine();
  if (engine === "ppocr") {
    const text = await runPpocr(file, onProgress, hooks);
    if (hooks && hooks.onEngine) hooks.onEngine({ engine: "ppocr", fellBack: false });
    return text;
  }
  let fellBack = false;
  if (engine === "auto" || engine === "textdetector") {
    if (isTextDetectorSupported()) {
      try {
        const text = await ocrWithTextDetector(file, onProgress);
        if (text && text.trim()) {
          if (hooks && hooks.onEngine) hooks.onEngine({ engine: "textdetector", fellBack: false });
          return text;
        }
      } catch {
        // detection failed — fall through to Tesseract rather than fail
      }
    }
    fellBack = true;
  }
  const text = await runTesseract(file, onProgress, hooks);
  if (hooks && hooks.onEngine) hooks.onEngine({ engine: "tesseract", fellBack });
  return text;
}
