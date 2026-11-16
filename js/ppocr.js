// OneSpends — PP-OCRv5 (tier 3) receipt OCR, fully on-device.
//
// A faithful JS port of the RapidOCR 3.10 pipeline the benchmark
// validated (~/workspace/onespends-benchmark/REPORT.md,
// scripts/run_ppocr.py):
//
//   ch_PP-OCRv5_det_mobile.onnx          4,819,576 B  sha256 4d97c44a…
//   ch_PP-OCRv5_rec_mobile.onnx         16,631,306 B  sha256 5825fc7e…
//   ch_PP-LCNet_x0_25_textline_ori_…     1,018,508 B  sha256 54379ae5…
//   ppocrv5_dict.txt (18,383 chars)         74,012 B  sha256 d1979e9f…
//
// Models + onnxruntime-web are vendored under /vendor/ppocr/ — zero
// runtime CDN; the service worker runtime-caches them on first use.
// The image never leaves the device.
//
// Pipeline (parameters mirror the Python prototype; see notes inline):
//   resize-within-bounds (max side 2000) → vertical padding →
//   det (limit 736/min, mean/std 0.5) → DB postprocess (thresh 0.3,
//   box_thresh 0.5, unclip 1.6, dilation on, min size 3) → sorted
//   boxes → perspective crops (h/w ≥ 1.5 → rot90) → cls [3,80,160]
//   (rotate 180 when P(180) > 0.9) → rec [3,48,W] batches of 6 →
//   CTC greedy decode → drop empty / score < 0.5 lines → MANDATORY
//   row clustering into visual lines → receipt text for parser.js.
//
// Channel order: OpenCV loads BGR and RapidOCR feeds BGR to the
// models, so decoded RGB pixels are channel-swapped once at input.
// All pixel ops below are pure JS on { data:Uint8ClampedArray(RGBA),
// width, height } buffers — the browser only uses canvas to decode,
// so the Node verification harness runs this exact code.
//
// Lazy-loaded by js/ocr.js only when PP-OCR actually runs.

// ---------------------------------------------------------------------
// Parameters (prototype values — do not tune without a benchmark)
// ---------------------------------------------------------------------
const GLOBAL_MAX_SIDE = 2000; // RapidOCR Global.max_side_len
const GLOBAL_MIN_SIDE = 30; //   Global.min_side_len
const PAD_MIN_HEIGHT = 30; //    Global.min_height
const PAD_WH_RATIO = 8; //       Global.width_height_ratio
const TEXT_SCORE = 0.5; //       Global.text_score (rec line filter)

const DET_LIMIT = 736; //        Det.limit_side_len, limit_type "min"
const DET_THRESH = 0.3;
const DET_BOX_THRESH = 0.5;
const DET_UNCLIP = 1.6;
const DET_MAX_CANDIDATES = 1000;
const DET_MIN_SIZE = 3;

const CLS_SHAPE = [3, 80, 160]; // PP-OCRv5 cls input
const CLS_THRESH = 0.9;
const REC_SHAPE = [3, 48, 320]; // rec_img_shape (width is a floor)
const REC_BATCH = 6;

export const PPOCR_READY_KEY = "onespends_ppocr_ready";
export const isPpocrReady = () => {
  try { return localStorage.getItem(PPOCR_READY_KEY) === "1"; } catch { return false; }
};
const markPpocrReady = () => {
  try { localStorage.setItem(PPOCR_READY_KEY, "1"); } catch { /* private mode */ }
};

// ---------------------------------------------------------------------
// Pixel helpers (RGBA buffers; channel-order agnostic)
// ---------------------------------------------------------------------
export function resizeBilinear(img, dstW, dstH) {
  const { data: src, width: sw, height: sh } = img;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const xRatio = sw / dstW, yRatio = sh / dstH;
  for (let y = 0; y < dstH; y++) {
    let sy = (y + 0.5) * yRatio - 0.5;
    sy = Math.min(Math.max(sy, 0), sh - 1);
    const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, sh - 1), fy = sy - y0;
    for (let x = 0; x < dstW; x++) {
      let sx = (x + 0.5) * xRatio - 0.5;
      sx = Math.min(Math.max(sx, 0), sw - 1);
      const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, sw - 1), fx = sx - x0;
      const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4;
      const i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const o = (y * dstW + x) * 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy);
      const w10 = (1 - fx) * fy, w11 = fx * fy;
      for (let c = 0; c < 4; c++) {
        out[o + c] = src[i00 + c] * w00 + src[i01 + c] * w01 +
                     src[i10 + c] * w10 + src[i11 + c] * w11;
      }
    }
  }
  return { data: out, width: dstW, height: dstH };
}

function sampleBilinear(img, sx, sy) {
  const { data: src, width: sw, height: sh } = img;
  sx = Math.min(Math.max(sx, 0), sw - 1); // BORDER_REPLICATE
  sy = Math.min(Math.max(sy, 0), sh - 1);
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
  const fx = sx - x0, fy = sy - y0;
  const px = [0, 0, 0, 0];
  const i00 = (y0 * sw + x0) * 4, i01 = (y0 * sw + x1) * 4;
  const i10 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
  for (let c = 0; c < 4; c++) {
    px[c] = src[i00 + c] * (1 - fx) * (1 - fy) + src[i01 + c] * fx * (1 - fy) +
            src[i10 + c] * (1 - fx) * fy + src[i11 + c] * fx * fy;
  }
  return px;
}

// Solve an 8x8 linear system (Gaussian elimination, partial pivot).
function solve8(A, b) {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Perspective-warp a quad [tl,tr,br,bl] of img into a w×h strip.
// (Prototype uses INTER_CUBIC; bilinear here — see report.)
export function warpQuad(img, pts, outW, outH) {
  const dst = [[0, 0], [outW, 0], [outW, outH], [0, outH]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = pts[i], [dx, dy] = dst[i];
    A.push([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy]); b.push(sx);
    A.push([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy]); b.push(sy);
  }
  const h = solve8(A, b);
  const out = new Uint8ClampedArray(outW * outH * 4);
  if (!h) return { data: out, width: outW, height: outH };
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const den = h[6] * x + h[7] * y + 1;
      const sx = (h[0] * x + h[1] * y + h[2]) / den;
      const sy = (h[3] * x + h[4] * y + h[5]) / den;
      const px = sampleBilinear(img, sx, sy);
      const o = (y * outW + x) * 4;
      out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2]; out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}

export function rotate90ccw(img) { // np.rot90
  const { data: src, width: w, height: h } = img;
  const out = new Uint8ClampedArray(src.length);
  for (let r = 0; r < w; r++) {
    for (let c = 0; c < h; c++) {
      const s = (c * w + (w - 1 - r)) * 4, d = (r * h + c) * 4;
      for (let k = 0; k < 4; k++) out[d + k] = src[s + k];
    }
  }
  return { data: out, width: h, height: w };
}

export function rotate180(img) {
  const { data: src, width: w, height: h } = img;
  const out = new Uint8ClampedArray(src.length);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const s = i * 4, d = (n - 1 - i) * 4;
    for (let k = 0; k < 4; k++) out[d + k] = src[s + k];
  }
  return { data: out, width: w, height: h };
}

function swapRB(img) {
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    const t = out[i]; out[i] = out[i + 2]; out[i + 2] = t;
  }
  return { data: out, width: img.width, height: img.height };
}

// ---------------------------------------------------------------------
// Geometry (min-area rect / unclip — ports of the DB postprocess)
// ---------------------------------------------------------------------
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Rotating-calipers min-area rectangle. Returns the 4 corners in
// cv2.boxPoints-style order (the order getMiniBox re-sorts anyway).
export function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length === 1) {
    const [x, y] = hull[0];
    return { points: [[x, y], [x, y], [x, y], [x, y]], width: 0, height: 0 };
  }
  if (hull.length === 2) {
    const [a, b] = hull;
    const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { points: [a, b, b, a], width: w, height: 0 };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const cos = Math.cos(-ang), sin = Math.sin(-ang);
    let minX = 1e18, maxX = -1e18, minY = 1e18, maxY = -1e18;
    for (const [x, y] of hull) {
      const rx = x * cos - y * sin, ry = x * sin + y * cos;
      if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
    }
    const area = (maxX - minX) * (maxY - minY);
    if (!best || area < best.area) best = { area, ang, minX, maxX, minY, maxY };
  }
  const cos = Math.cos(best.ang), sin = Math.sin(best.ang);
  const corners = [[best.minX, best.minY], [best.maxX, best.minY], [best.maxX, best.maxY], [best.minX, best.maxY]]
    .map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
  return {
    points: corners,
    width: best.maxX - best.minX,
    height: best.maxY - best.minY,
  };
}

// Port of RapidOCR get_mini_boxes: order a min-area rect's corners as
// [top-left, top-right, bottom-right, bottom-left]; returns the box
// and its short side.
function getMiniBoxes(contourPts) {
  const rect = minAreaRect(contourPts);
  const points = [...rect.points].sort((a, b) => a[0] - b[0]); // stable, by x
  let i1, i2, i3, i4;
  if (points[1][1] > points[0][1]) { i1 = 0; i4 = 1; } else { i1 = 1; i4 = 0; }
  if (points[3][1] > points[2][1]) { i2 = 2; i3 = 3; } else { i2 = 3; i3 = 2; }
  const box = [points[i1], points[i2], points[i3], points[i4]];
  return { box, sside: Math.min(rect.width, rect.height) };
}

function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
function polygonPerimeter(poly) {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}

// Unclip a rectangle by distance = area * ratio / perimeter along its
// own axes (the min-area-rect input is a rectangle, so axis expansion
// matches pyclipper's offset up to corner joins).
export function unclipBox(box, ratio) {
  const d = (polygonArea(box) * ratio) / polygonPerimeter(box);
  const [tl, tr, br, bl] = box;
  const cx = (tl[0] + tr[0] + br[0] + bl[0]) / 4;
  const cy = (tl[1] + tr[1] + br[1] + bl[1]) / 4;
  const ux = tr[0] - tl[0], uy = tr[1] - tl[1];
  const vx = bl[0] - tl[0], vy = bl[1] - tl[1];
  const lu = Math.hypot(ux, uy) || 1, lv = Math.hypot(vx, vy) || 1;
  const ex = (ux / lu) * d, ey = (uy / lu) * d;
  const fx = (vx / lv) * d, fy = (vy / lv) * d;
  const corner = (su, sv) => [cx + su * (ux / 2 + ex) + sv * (vx / 2 + fx),
                              cy + su * (uy / 2 + ey) + sv * (vy / 2 + fy)];
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

// Mean of the probability map inside a polygon (box_score_fast port).
function boxScoreFast(prob, pw, ph, box) {
  const xs = box.map((p) => p[0]), ys = box.map((p) => p[1]);
  const xmin = Math.min(Math.max(Math.floor(Math.min(...xs)), 0), pw - 1);
  const xmax = Math.min(Math.max(Math.ceil(Math.max(...xs)), 0), pw - 1);
  const ymin = Math.min(Math.max(Math.floor(Math.min(...ys)), 0), ph - 1);
  const ymax = Math.min(Math.max(Math.ceil(Math.max(...ys)), 0), ph - 1);
  let sum = 0, cnt = 0;
  for (let y = ymin; y <= ymax; y++) {
    for (let x = xmin; x <= xmax; x++) {
      // even-odd point-in-polygon at pixel centre
      let inside = false;
      for (let i = 0, j = box.length - 1; i < box.length; j = i++) {
        const [xi, yi] = box[i], [xj, yj] = box[j];
        if ((yi > y + 0.5) !== (yj > y + 0.5) &&
            x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) { sum += prob[y * pw + x]; cnt++; }
    }
  }
  return cnt ? sum / cnt : 0;
}

// Connected components (8-connectivity) over the thresholded map;
// returns each component's boundary pixels (4-neighbour test), which
// is all minAreaRect needs. (cv2 uses RETR_LIST contours — hole
// contours are interior and cannot change the min-area rect.)
function components(bitmap, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let start = 0; start < w * h && comps.length < DET_MAX_CANDIDATES; start++) {
    if (!bitmap[start] || labels[start] !== -1) continue;
    const id = comps.length;
    const boundary = [];
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % w, y = (idx / w) | 0;
      let isB = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) { if (Math.abs(dx) + Math.abs(dy) === 1) isB = true; continue; }
          const n = ny * w + nx;
          if (bitmap[n]) {
            if (labels[n] === -1) { labels[n] = id; stack.push(n); }
          } else if (Math.abs(dx) + Math.abs(dy) === 1) isB = true;
        }
      }
      if (isB) boundary.push([x, y]);
    }
    comps.push(boundary);
  }
  return comps;
}

// DB postprocess: probability map → boxes in destination-image coords.
export function dbPostProcess(prob, pw, ph, destW, destH) {
  let bitmap = new Uint8Array(pw * ph);
  for (let i = 0; i < pw * ph; i++) bitmap[i] = prob[i] > DET_THRESH ? 1 : 0;
  // dilation with the 2x2 kernel cv2 applies (anchor centre)
  const dil = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = y * pw + x;
      dil[i] = bitmap[i] ||
        (x > 0 && bitmap[i - 1]) || (y > 0 && bitmap[i - pw]) ||
        (x > 0 && y > 0 && bitmap[i - pw - 1]) ? 1 : 0;
    }
  }
  bitmap = dil;
  const boxes = [];
  for (const pts of components(bitmap, pw, ph)) {
    if (pts.length < 4) continue;
    const first = getMiniBoxes(pts);
    if (first.sside < DET_MIN_SIZE) continue;
    if (boxScoreFast(prob, pw, ph, first.box) < DET_BOX_THRESH) continue;
    const expanded = unclipBox(first.box, DET_UNCLIP);
    const second = getMiniBoxes(expanded);
    if (second.sside < DET_MIN_SIZE + 2) continue;
    const box = second.box.map(([x, y]) => [
      Math.min(Math.max(Math.round((x / pw) * destW), 0), destW),
      Math.min(Math.max(Math.round((y / ph) * destH), 0), destH),
    ]);
    boxes.push(box);
  }
  // filter_det_res: order points clockwise, clip, drop tiny rects
  return boxes.filter((box) => {
    const wdt = Math.trunc(Math.hypot(box[0][0] - box[1][0], box[0][1] - box[1][1]));
    const hgt = Math.trunc(Math.hypot(box[0][0] - box[3][0], box[0][1] - box[3][1]));
    return wdt > 3 && hgt > 3;
  });
}

// Detector's own reading-order sort (bubble-adjusted): stable sort by
// top y; a ≥10px y jump starts a new line; sort by x within a line.
export function sortDetBoxes(boxes) {
  const arr = boxes.map((box, i) => ({ box, i }));
  arr.sort((a, b) => (a.box[0][1] - b.box[0][1]) || (a.i - b.i));
  // numpy argsort(y) then line ids from ADJACENT diffs (dy >= 10 → new
  // line), then lexsort by (line_id, x): a box joins the previous line
  // iff its y differs from its sorted neighbour's by < 10.
  const lines = [];
  let prevY = null;
  for (const it of arr) {
    if (prevY === null || it.box[0][1] - prevY >= 10) lines.push([it]);
    else lines[lines.length - 1].push(it);
    prevY = it.box[0][1];
  }
  const out = [];
  for (const line of lines) {
    line.sort((a, b) => a.box[0][0] - b.box[0][0]);
    out.push(...line.map((it) => it.box));
  }
  return out;
}

// ---------------------------------------------------------------------
// CTC greedy decode (RapidOCR CTCLabelDecode port)
// chars: index → character table, chars[0] is the blank placeholder.
// ---------------------------------------------------------------------
export function ctcGreedyDecode(logits, T, C, chars) {
  let text = "";
  let scoreSum = 0, scoreCnt = 0;
  let prevIdx = -1;
  for (let t = 0; t < T; t++) {
    const off = t * C;
    let idx = 0, best = -Infinity;
    for (let c = 0; c < C; c++) {
      const v = logits[off + c];
      if (v > best) { best = v; idx = c; }
    }
    if (idx === prevIdx) continue; // remove duplicates (raw sequence)
    prevIdx = idx;
    if (idx === 0) continue; // blank
    const ch = chars[idx];
    if (ch === undefined) continue;
    text += ch;
    scoreSum += best; scoreCnt++;
  }
  return { text, score: scoreCnt ? scoreSum / scoreCnt : 0 };
}

// ---------------------------------------------------------------------
// Mandatory row clustering — EXACT port of run_ppocr.py.
// ---------------------------------------------------------------------
export function clusterRows(items) {
  const rows = items.map(({ txt, box }) => {
    const ys = box.map((p) => p[1]), xs = box.map((p) => p[0]);
    return {
      cy: ys.reduce((a, b) => a + b, 0) / ys.length,
      h: Math.max(...ys) - Math.min(...ys),
      x: Math.min(...xs),
      txt,
    };
  });
  rows.sort((a, b) => a.cy - b.cy);
  const heights = rows.map((r) => r.h).sort((a, b) => a - b);
  const medH = heights.length ? heights[Math.floor(heights.length / 2)] : 16;
  const tol = Math.max(8, 0.55 * medH);
  const clusters = [];
  for (const r of rows) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(r.cy - last[0].cy) <= tol) last.push(r);
    else clusters.push([r]);
  }
  return clusters
    .map((c) => c.sort((a, b) => a.x - b.x).map((r) => r.txt).join(" "))
    .join("\n");
}

// ---------------------------------------------------------------------
// Tensor builders
// ---------------------------------------------------------------------
function toTensorCHW(img, mean, std) {
  // (v/255 - mean) / std per channel, CHW float32
  const { data, width: w, height: h } = img;
  const out = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      out[c * plane + i] = (data[i * 4 + c] / 255 - mean[c]) / std[c];
    }
  }
  return out;
}

// Resize so the min side reaches `limit` (det "min" limit type),
// dims rounded to multiples of 32 — DetPreProcess.resize port.
function detResize(img) {
  const { width: w, height: h } = img;
  let ratio = 1;
  if (Math.min(h, w) < DET_LIMIT) ratio = h < w ? DET_LIMIT / h : DET_LIMIT / w;
  const rw = Math.max(32, Math.round((w * ratio) / 32) * 32);
  const rh = Math.max(32, Math.round((h * ratio) / 32) * 32);
  return (rw === w && rh === h) ? img : resizeBilinear(img, rw, rh);
}

// cls/rec shared resize: fit height, keep aspect, zero-pad right.
function resizeNormStrip(img, imgH, imgW) {
  const ratio = img.width / img.height;
  const resizedW = Math.ceil(imgH * ratio) > imgW ? imgW : Math.ceil(imgH * ratio);
  const resized = resizeBilinear(img, Math.max(1, resizedW), imgH);
  const out = new Float32Array(3 * imgH * imgW);
  const plane = imgH * imgW;
  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < resizedW; x++) {
      const i = (y * resizedW + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[c * plane + y * imgW + x] = (resized.data[i + c] / 255 - 0.5) / 0.5;
      }
    }
  }
  return out;
}

// Global preprocess: resize within bounds (max 2000 / min 30, /32
// rounding — reduce_max_side / increase_min_side ports).
function resizeWithinBounds(img) {
  let { width: w, height: h } = img;
  let cur = img;
  const scaled = (ratio) => {
    const rw = Math.round((w * ratio) / 32) * 32;
    const rh = Math.round((h * ratio) / 32) * 32;
    if (rw <= 0 || rh <= 0 || (rw === w && rh === h)) return null;
    cur = resizeBilinear(cur, rw, rh);
    w = rw; h = rh;
    return cur;
  };
  if (Math.max(h, w) > GLOBAL_MAX_SIDE) scaled(GLOBAL_MAX_SIDE / Math.max(h, w));
  if (Math.min(h, w) < GLOBAL_MIN_SIDE) scaled(GLOBAL_MIN_SIDE / Math.min(h, w));
  return { img: cur, ratioH: img.height / h, ratioW: img.width / w };
}

// ---------------------------------------------------------------------
// Engine factory. deps:
//   ort            — onnxruntime (web or node) namespace
//   loadModel(url) — Promise<ArrayBuffer> (progress handled by caller
//                    via deps.onBytes if provided)
//   loadDict()     — Promise<string[]> dictionary lines (no blank/space)
//   decodeImage(source) — Promise<{data,width,height}> RGB pixels
//   urls           — { det, rec, cls } model URLs (or keys for loader)
// ---------------------------------------------------------------------
export function createPpocrEngine(deps) {
  const sessions = {};
  let dictChars = null;
  let initPromise = null;

  async function init(onProgress) {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const [detBuf, recBuf, clsBuf, dictLines] = await Promise.all([
        deps.loadModel(deps.urls.det),
        deps.loadModel(deps.urls.rec),
        deps.loadModel(deps.urls.cls),
        deps.loadDict(),
      ]);
      if (onProgress) onProgress(58);
      const opts = {
        executionProviders: deps.executionProviders || ["wasm"],
        graphOptimizationLevel: "all",
      };
      sessions.det = await deps.ort.InferenceSession.create(detBuf, opts);
      sessions.rec = await deps.ort.InferenceSession.create(recBuf, opts);
      sessions.cls = await deps.ort.InferenceSession.create(clsBuf, opts);
      // CTC table: blank at 0, dictionary chars, space appended last
      dictChars = ["blank", ...dictLines, " "];
      if (onProgress) onProgress(65);
    })();
    initPromise.catch(() => { initPromise = null; }); // allow retry
    return initPromise;
  }

  async function runSession(session, data, dims) {
    const name = session.inputNames[0];
    const tensor = new deps.ort.Tensor("float32", data, dims);
    const out = await session.run({ [name]: tensor });
    return out[session.outputNames[0]];
  }

  async function recognize(source, onProgress) {
    await init(onProgress);
    const report = (p) => { if (onProgress) onProgress(p); };

    // --- decode + BGR swap (OpenCV channel order) ---
    const decoded = await deps.decodeImage(source);
    const rgb = { data: decoded.data, width: decoded.width, height: decoded.height };
    const img0 = swapRB(rgb);
    const oriW = img0.width, oriH = img0.height;

    // --- global preprocess: within bounds + vertical padding ---
    const { img: pre, ratioH, ratioW } = resizeWithinBounds(img0);
    let work = pre, padTop = 0;
    {
      const { width: w, height: h } = pre;
      if (h <= PAD_MIN_HEIGHT || w / h > PAD_WH_RATIO) {
        const newH = Math.max(Math.trunc(w / PAD_WH_RATIO), PAD_MIN_HEIGHT) * 2;
        padTop = Math.trunc(Math.abs(newH - h) / 2);
        if (padTop > 0) {
          const padded = new Uint8ClampedArray(w * (h + padTop * 2) * 4);
          for (let i = 3; i < padded.length; i += 4) padded[i] = 255;
          padded.set(pre.data, padTop * w * 4);
          work = { data: padded, width: w, height: h + padTop * 2 };
        }
      }
    }
    report(70);

    // --- detection ---
    const detImg = detResize(work);
    const detTensor = toTensorCHW(detImg, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    const detOut = await runSession(sessions.det, detTensor, [1, 3, detImg.height, detImg.width]);
    const prob = detOut.data;
    let boxes = dbPostProcess(prob, detImg.width, detImg.height, work.width, work.height);
    boxes = sortDetBoxes(boxes);
    report(78);
    if (!boxes.length) return { text: "", lines: [] };

    // --- crops (perspective; tall strips rotated, per prototype) ---
    const crops = boxes.map((box) => {
      const cropW = Math.max(1, Math.trunc(Math.max(
        Math.hypot(box[0][0] - box[1][0], box[0][1] - box[1][1]),
        Math.hypot(box[2][0] - box[3][0], box[2][1] - box[3][1]))));
      const cropH = Math.max(1, Math.trunc(Math.max(
        Math.hypot(box[0][0] - box[3][0], box[0][1] - box[3][1]),
        Math.hypot(box[1][0] - box[2][0], box[1][1] - box[2][1]))));
      let crop = warpQuad(work, box, cropW, cropH);
      if (crop.height / crop.width >= 1.5) crop = rotate90ccw(crop);
      return crop;
    });

    // --- orientation classification [3,80,160], batch all ---
    {
      const [_, ch, cw] = CLS_SHAPE;
      const batch = new Float32Array(crops.length * 3 * ch * cw);
      crops.forEach((crop, i) => {
        batch.set(resizeNormStrip(crop, ch, cw), i * 3 * ch * cw);
      });
      const out = await runSession(sessions.cls, batch, [crops.length, 3, ch, cw]);
      const probs = out.data; // [N, 2] labels ["0", "180"]
      for (let i = 0; i < crops.length; i++) {
        const p180 = probs[i * 2 + 1];
        if (p180 > CLS_THRESH && p180 >= probs[i * 2]) crops[i] = rotate180(crops[i]);
      }
    }
    report(85);

    // --- recognition, batches of 6 sorted by width ratio ---
    const order = crops.map((c, i) => ({ i, r: c.width / c.height }))
      .sort((a, b) => a.r - b.r).map((o) => o.i);
    const results = new Array(crops.length);
    for (let beg = 0; beg < order.length; beg += REC_BATCH) {
      const idxs = order.slice(beg, beg + REC_BATCH);
      let maxWh = REC_SHAPE[2] / REC_SHAPE[1];
      for (const i of idxs) maxWh = Math.max(maxWh, crops[i].width / crops[i].height);
      const imgW = Math.trunc(REC_SHAPE[1] * maxWh);
      const batch = new Float32Array(idxs.length * 3 * REC_SHAPE[1] * imgW);
      idxs.forEach((ci, k) => {
        batch.set(resizeNormStrip(crops[ci], REC_SHAPE[1], imgW), k * 3 * REC_SHAPE[1] * imgW);
      });
      const out = await runSession(sessions.rec, batch, [idxs.length, 3, REC_SHAPE[1], imgW]);
      const T = out.dims[1], C = out.dims[2];
      idxs.forEach((ci, k) => {
        const logits = out.data.subarray(k * T * C, (k + 1) * T * C);
        results[ci] = ctcGreedyDecode(logits, T, C, dictChars);
      });
    }
    report(96);

    // --- filter + map boxes to original image + cluster rows ---
    const items = [];
    for (let i = 0; i < boxes.length; i++) {
      const r = results[i];
      if (!r || !r.text.trim() || r.score < TEXT_SCORE) continue;
      const box = boxes[i].map(([x, y]) => [
        Math.min(Math.max((x * ratioW), 0), oriW),
        Math.min(Math.max(((y - padTop) * ratioH), 0), oriH),
      ]);
      items.push({ txt: r.text, box, score: r.score });
    }
    const text = items.length ? clusterRows(items) : "";
    report(100);
    return { text, lines: items };
  }

  return { init, recognize };
}

// ---------------------------------------------------------------------
// Browser glue — canvas decode + same-origin fetches + ORT wasm.
// ---------------------------------------------------------------------
const PP_BASE = typeof import.meta !== "undefined" && import.meta.url
  ? new URL("../vendor/ppocr/", import.meta.url) : null;
// Honest first-use payload denominator: models (det 4,819,576 + rec
// 16,631,306 + cls 1,018,508 = 22,469,390) + dict 74,012 + the
// onnxruntime-web runtime (ort.wasm.min.js 49,026 +
// ort-wasm-simd-threaded.wasm 11,246,032 + .mjs glue 24,618) =
// 33,863,078 bytes total — the ≈34 MB figure quoted in the UI.
const DOWNLOAD_TOTAL_BYTES =
  4819576 + 16631306 + 1018508 + 74012 + 49026 + 11246032 + 24618; // 33,863,078
const ORT_JS_BYTES = 49026; // ort.wasm.min.js, loaded before the models

let ortPromise = null;
function loadOrt() {
  if (window.ort) return Promise.resolve(window.ort);
  if (ortPromise) return ortPromise;
  ortPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("ort.wasm.min.js", PP_BASE).href;
    s.async = true;
    s.onload = () => {
      const ort = window.ort;
      ort.env.wasm.wasmPaths = PP_BASE.href;
      ort.env.wasm.numThreads = 1; // no COOP/COEP on Pages → no SAB
      resolve(ort);
    };
    s.onerror = () => reject(new Error("PP-OCRv5 引擎載入失敗 — 可以改用 Tesseract 或手動入數。"));
    document.head.appendChild(s);
  });
  return ortPromise;
}

async function decodeWithCanvas(source) {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: d.data, width: d.width, height: d.height };
  } finally {
    if (typeof bitmap.close === "function") bitmap.close();
  }
}

let browserEngine = null;
async function getBrowserEngine(onProgress) {
  if (browserEngine) return browserEngine;
  const ort = await loadOrt();
  // The ort JS bundle is already on the device at this point — count
  // it, so the % reflects the whole first-use payload, not just the
  // models. (The 11.25 MB wasm binary itself arrives during session
  // init — the 58→65 milestones — after this download phase.)
  let loadedBytes = ORT_JS_BYTES;
  const fetchModel = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error("PP-OCRv5 模型下載失敗 — 檢查網絡後再試。");
    const buf = await res.arrayBuffer();
    loadedBytes += buf.byteLength;
    if (onProgress) onProgress(Math.round((loadedBytes / DOWNLOAD_TOTAL_BYTES) * 55));
    return buf;
  };
  browserEngine = createPpocrEngine({
    ort,
    urls: {
      det: new URL("models/det.onnx", PP_BASE).href,
      rec: new URL("models/rec.onnx", PP_BASE).href,
      cls: new URL("models/cls.onnx", PP_BASE).href,
    },
    loadModel: fetchModel,
    loadDict: async () => {
      const res = await fetch(new URL("models/ppocrv5_dict.txt", PP_BASE));
      if (!res.ok) throw new Error("PP-OCRv5 字典下載失敗。");
      const buf = await res.arrayBuffer();
      loadedBytes += buf.byteLength;
      if (onProgress) onProgress(Math.round((loadedBytes / DOWNLOAD_TOTAL_BYTES) * 55));
      const lines = new TextDecoder().decode(buf).split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      return lines;
    },
    decodeImage: decodeWithCanvas,
  });
  return browserEngine;
}

/**
 * Recognize a receipt image with PP-OCRv5 (browser entry point).
 * source: File/Blob. onProgress(0..100): first-use download
 * (runtime + models + dict, byte-counted against the full payload)
 * ≈0–55, session init →65, detection →78, cls →85, rec →96–100.
 * Returns the clustered receipt text.
 */
export async function recognizeReceiptImage(source, onProgress) {
  const engine = await getBrowserEngine(onProgress);
  const { text } = await engine.recognize(source, onProgress);
  markPpocrReady();
  return text;
}
