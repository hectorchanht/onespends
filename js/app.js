// OneSpends — app logic for /app. All data lives in IndexedDB on this device.
import { getAllSpends, addSpend, addManySpends, updateSpend, deleteSpend } from "./db.js";
import { parseReceiptText, parseCSV, parseJSON, parseHTML, filterNewRecords, CATEGORIES } from "./parser.js";
import { prepareDataSource, demoRecords } from "./seed.js";
import { initStats, renderDashboardCharts, renderStats } from "./stats.js";
import * as sync from "./sync.js";

const $ = (sel) => document.querySelector(sel);

// Fixed icon + color slot per category (color follows the category, never its rank).
const CAT_META = {
  "餐飲": { icon: "🍜", slot: 1 },
  "交通": { icon: "🚌", slot: 2 },
  "購物": { icon: "🛍️", slot: 3 },
  "娛樂": { icon: "🎬", slot: 4 },
  "家居": { icon: "🏠", slot: 5 },
  "醫療": { icon: "💊", slot: 6 },
  "訂閱": { icon: "🔁", slot: 7 },
  "旅行": { icon: "✈️", slot: 8 },
  "其他": { icon: "📦", slot: 9 },
  "未分類": { icon: "❓", slot: 9 },
};
const catIcon = (c) => (CAT_META[c] || CAT_META["其他"]).icon;
const catSlot = (c) => (CAT_META[c] || CAT_META["其他"]).slot;
const RECENT_LIMIT = 8;

let spends = [];
let editingId = null;
let pendingSource = "manual";
// Last receipt scan that filled the form: { file, parsed } — the
// PP-OCRv5 escalation retry (auto engine, incomplete parse) needs the
// same image again and the parse it has to beat.
let lastScan = null;
let showAllRecent = false;
let isDemoSession = false;

// ----- tour preview state (render-layer demo; see enterPreview below) -----
let previewActive = false;
let previewSaved = null;
let resolveReady = null;
const readyPromise = new Promise((res) => { resolveReady = res; });

const monthInput = $("#monthPicker");
const monthButton = $("#monthButton");
const monthPanel = $("#monthPickerPanel");
const monthLabel = $("#monthLabel");
const monthPickerTitle = $("#monthPickerTitle");
function formatMonthLabel(key) {
  const m = /^(\d{4})-(\d{2})/.exec(key || "");
  return m ? `${Number(m[1])}年${Number(m[2])}月` : "本月";
}
function syncMonthUI() {
  const label = formatMonthLabel(currentKey());
  monthLabel.textContent = label;
  monthPickerTitle.textContent = label;
}
function setMonthPanel(open) {
  monthPanel.hidden = !open;
  monthButton.setAttribute("aria-expanded", String(open));
  if (open) syncMonthUI();
}
const previewBadge = $("#previewBadge");
const form = $("#spendForm");
const spendDialog = $("#spendDialog");
const importDialog = $("#importDialog");
const settingsDialog = $("#settingsDialog");
const accountDialog = $("#accountDialog");

// ----- helpers -----
const pad2 = (n) => String(n).padStart(2, "0");
function isoOf(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayISO() { return isoOf(new Date()); }
function monthKeyOf(iso) { return (iso || "").slice(0, 7); }

function shiftMonthKey(key, delta) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}
const prevMonthKey = (key) => shiftMonthKey(key, -1);

function fmt(amount, currency) {
  try {
    return new Intl.NumberFormat("zh-Hant", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

function fractionDigits(currency) {
  try { return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits; }
  catch { return 2; }
}

// Plain number in the currency's precision (the currency code is shown as a label).
function fmtNum(amount, currency, compact = false) {
  const d = compact && Math.abs(amount) >= 1000 ? 0 : fractionDigits(currency);
  return new Intl.NumberFormat("en", { minimumFractionDigits: d, maximumFractionDigits: d }).format(amount);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function sumsByCurrency(list) {
  const map = new Map();
  for (const r of list) map.set(r.currency, (map.get(r.currency) || 0) + Number(r.amount));
  return map;
}

function currentKey() { return monthInput.value || monthKeyOf(todayISO()); }

// ----- (a) glance cards -----
function renderGlance(thisMonth, cur, prev) {
  const el = $("#glanceCards");
  const ccys = [...new Set([...cur.keys(), ...prev.keys()])]
    .sort((a, b) => (cur.get(b) || 0) - (cur.get(a) || 0) || (prev.get(b) || 0) - (prev.get(a) || 0));
  if (!ccys.length) {
    el.innerHTML = `<article class="glance-card primary empty-card">
      <div class="gc-top"><span class="gc-ccy">本月使費</span></div>
      <div class="gc-amt">0</div>
      <div class="gc-sub">未有記錄</div>
      <div class="gc-actions">
        <button type="button" class="gc-btn" data-act="scan" aria-label="影收據" title="影收據"><span aria-hidden="true">📷</span></button>
        <button type="button" class="gc-btn" data-act="add" aria-label="加一筆" title="加一筆"><span aria-hidden="true">＋</span></button>
        <button type="button" class="gc-btn" data-act="import" aria-label="匯入檔案" title="匯入檔案"><span aria-hidden="true">⬆</span></button>
      </div>
      <a class="gc-demo" href="./app?demo=1">睇示範數據 →</a>
    </article>`;
    return;
  }
  const big = ccys.slice(0, 3);
  const rest = ccys.slice(3);
  el.innerHTML = big.map((ccy, i) => {
    const total = cur.get(ccy) || 0;
    const p = prev.get(ccy);
    const n = thisMonth.filter((r) => r.currency === ccy).length;
    let delta = `<span class="gc-delta none" title="上月冇記錄">新</span>`;
    if (p !== undefined && p !== 0) {
      const diff = total - p;
      const pct = Math.round((diff / p) * 100);
      const cls = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
      const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "＝";
      delta = `<span class="gc-delta ${cls}" title="上月 ${esc(fmt(p, ccy))}">${arrow} ${Math.abs(pct)}%</span>`;
    }
    const [int, dec] = fmtNum(total, ccy).split(".");
    return `<article class="glance-card${i === 0 ? " primary" : ""}" aria-label="${esc(ccy)} 本月 ${esc(fmt(total, ccy))}">
      <div class="gc-top"><span class="gc-ccy">${esc(ccy)}</span><span class="gc-count">${n} 筆</span></div>
      <div class="gc-amt">${esc(int)}${dec ? `<small>.${esc(dec)}</small>` : ""}</div>
      <div class="gc-foot">${delta}<span class="gc-vs">vs 上月</span></div>
    </article>`;
  }).join("") + (rest.length
    ? `<div class="glance-more">${rest.map((c) => `<span class="chip">${esc(c)} ${esc(fmtNum(cur.get(c) || 0, c, true))}</span>`).join("")}</div>`
    : "");
}

// ----- (b)+(c) dashboard charts -----
// Donut + last-7-days bars are Chart.js charts (vendored, lazily loaded by
// js/stats.js). Their scope is unchanged: the dashboard month + its primary
// currency. Rendering is fire-and-forget so first paint never waits for the
// chart library; js/stats.js shows a worded fallback if it cannot load.
function renderCharts(thisMonth, primary, key) {
  renderDashboardCharts({ spends, thisMonth, primary, monthKey: key, today: todayISO() })
    .catch(() => {});
}

// ----- dashboard -----
function renderDashboard() {
  const key = currentKey();
  const thisMonth = spends.filter((r) => monthKeyOf(r.date) === key);
  const lastMonth = spends.filter((r) => monthKeyOf(r.date) === prevMonthKey(key));
  const cur = sumsByCurrency(thisMonth);
  const prev = sumsByCurrency(lastMonth);
  renderGlance(thisMonth, cur, prev);

  // primary currency = largest this-month total (fallback: last month, then any record)
  const pick = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const primary = pick(cur) || pick(prev) || spends[0]?.currency || "";
  renderCharts(thisMonth, primary, key);
  const donutEmpty = !thisMonth.some((r) => r.currency === primary);
  $("#donutPanel").classList.toggle("is-empty", donutEmpty);
  $("#donutHint").hidden = !donutEmpty;
  $("#nextMonth").disabled = key >= monthKeyOf(todayISO());
  syncMonthUI();
}

// ----- (d) recent spends -----
function renderList() {
  const el = $("#recentList");
  const recent = showAllRecent ? spends : spends.slice(0, RECENT_LIMIT);
  const more = $("#moreRecent");
  more.hidden = spends.length <= RECENT_LIMIT;
  more.innerHTML = showAllRecent
    ? `<span aria-hidden="true">▴</span>`
    : `<span aria-hidden="true">▾</span> ${spends.length}`;
  more.setAttribute("aria-label", showAllRecent ? "收起" : `顯示全部 ${spends.length} 筆`);
  more.title = showAllRecent ? "收起" : "顯示全部";
  if (!recent.length) {
    el.innerHTML = `<li class="empty-row"><span aria-hidden="true">🧾</span> 未有記錄 <button type="button" class="link-btn" data-act="add-first">＋ 加第一筆</button></li>`;
    return;
  }
  el.innerHTML = recent.map((r) => `
    <li><button type="button" class="spend-row" data-id="${esc(r.id)}" aria-label="編輯 ${esc(r.vendor)} ${esc(fmt(r.amount, r.currency))}">
      <span class="sr-icon cat-bg-${catSlot(r.category)}" aria-hidden="true">${catIcon(r.category)}</span>
      <span class="sr-main"><span class="sr-vendor">${esc(r.vendor)}</span><span class="sr-date">${esc(String(r.date).slice(5).replace("-", "/"))}${r.note ? " · " + esc(r.note) : ""}</span></span>
      <span class="sr-amt">${esc(fmtNum(r.amount, r.currency))}<small>${esc(r.currency)}</small></span>
    </button></li>`).join("");
}

function render() {
  renderDashboard();
  renderList();
  // Statistics has its own range state (anchored to today in js/stats.js);
  // it renders from the same spends array, so the tour's demo preview —
  // which swaps that array and calls render() — shows filled stats too.
  // The stats layer is optional: it must never be able to break the
  // dashboard render above it, so the call is failure-isolated.
  try {
    renderStats(spends).catch(() => {});
  } catch { /* stats unavailable — dashboard already rendered */ }
}

// ----- tour preview: the "finished look", rendered from demo data only -----
// enterPreview swaps the in-memory `spends` array for the fictional demo
// dataset and renders it. No IndexedDB read or write happens here, the active
// database is never switched, and exitPreview restores the saved array +
// selected month verbatim. While preview is on, every write path below
// (add / edit / delete / import) refuses via previewGuard().
function previewGuard() {
  if (!previewActive) return false;
  setStatus("而家係示範預覽 — 完成導覽後先可以改資料。", true);
  return true;
}

function enterPreview() {
  if (previewActive) return true;
  if (isDemoSession) return true; // ?demo=1 already renders the demo dataset
  previewSaved = { spends, month: monthInput.value, showAllRecent };
  spends = demoRecords();
  showAllRecent = false;
  monthInput.value = monthKeyOf(todayISO());
  previewActive = true;
  previewBadge.hidden = false;
  document.body.classList.add("preview-on");
  render();
  return true;
}

function exitPreview() {
  if (!previewActive) return;
  previewActive = false;
  previewBadge.hidden = true;
  document.body.classList.remove("preview-on");
  if (previewSaved) {
    spends = previewSaved.spends;
    monthInput.value = previewSaved.month;
    showAllRecent = previewSaved.showAllRecent;
    previewSaved = null;
  }
  render();
  // A sync landed while the preview was up: re-read so the restored view
  // doesn't sit on the pre-sync snapshot.
  if (pendingDataRefresh) {
    pendingDataRefresh = false;
    refresh().catch(() => {});
  }
}

window.OneSpendsPreview = {
  enter: enterPreview,
  exit: exitPreview,
  isActive: () => previewActive,
  whenReady: () => readyPromise,
};

async function refresh() {
  spends = await getAllSpends();
  render();
}

let statusTimer = null;
function setStatus(msg, isError = false) {
  const el = $("#status");
  el.textContent = msg;
  el.className = "status toast" + (isError ? " error" : "");
  el.hidden = !msg;
  clearTimeout(statusTimer);
  if (msg) statusTimer = setTimeout(() => { el.hidden = true; }, isError ? 8000 : 4500);
}

// ----- dialogs -----
function openDialog(d) {
  if (d.open) return;
  if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
}
function closeDialog(d) {
  if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
}
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => closeDialog(b.closest("dialog"))));
[spendDialog, importDialog, settingsDialog, accountDialog].forEach((d) => d.addEventListener("click", (e) => { if (e.target === d) closeDialog(d); }));

// ----- (e) form: add / edit / delete -----
function resetForm() {
  form.reset();
  editingId = null;
  pendingSource = "manual";
  lastScan = null;
  $("#ppRetryWrap").hidden = true;
  $("#cancelledBanner").hidden = true;
  $("#dateHint").hidden = true;
  $("#date").value = todayISO();
  $("#category").value = "未分類";
  $("#currency").value = "HKD";
  $("#formTitle").textContent = "＋ 加一筆";
  $("#submitBtn").setAttribute("aria-label", "儲存");
  $("#submitBtn").title = "儲存";
  $("#cancelEdit").hidden = true;
  $("#deleteBtn").hidden = true;
}

function openAdd() {
  if (previewGuard()) return;
  resetForm();
  openDialog(spendDialog);
  setTimeout(() => $("#vendor").focus(), 50);
}

function openEdit(rec) {
  if (previewGuard()) return;
  editingId = rec.id;
  $("#vendor").value = rec.vendor;
  $("#amount").value = rec.amount;
  $("#currency").value = rec.currency;
  $("#date").value = rec.date;
  $("#category").value = rec.category;
  $("#note").value = rec.note || "";
  $("#formTitle").textContent = "✎ 編輯";
  $("#submitBtn").setAttribute("aria-label", "更新");
  $("#submitBtn").title = "更新";
  $("#cancelEdit").hidden = false;
  $("#deleteBtn").hidden = false;
  openDialog(spendDialog);
}

$("#addBtn").addEventListener("click", openAdd);

// empty-state glance card actions (card is re-rendered via innerHTML, so delegate)
$("#glanceCards").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "scan") $("#scanButton").click();
  else if (btn.dataset.act === "add") openAdd();
  else if (btn.dataset.act === "import") openDialog(importDialog);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (previewGuard()) return;
  const rec = {
    vendor: $("#vendor").value.trim(),
    amount: parseFloat($("#amount").value),
    currency: $("#currency").value,
    date: $("#date").value,
    category: $("#category").value,
    note: $("#note").value.trim(),
    source: editingId ? (spends.find((s) => s.id === editingId)?.source || "manual") : pendingSource,
  };
  if (!rec.vendor || !Number.isFinite(rec.amount) || rec.amount < 0 || !rec.date) {
    setStatus("請填好商戶、金額同日期（金額可填 0）。", true);
    return;
  }
  if (editingId) {
    await updateSpend(editingId, rec);
    setStatus("已更新。");
  } else {
    await addSpend(rec);
    setStatus("已儲存。");
  }
  // jump to the saved record's month so it shows on the dashboard
  monthInput.value = monthKeyOf(rec.date);
  resetForm();
  closeDialog(spendDialog);
  await refresh();
});

$("#cancelEdit").addEventListener("click", () => { resetForm(); closeDialog(spendDialog); setStatus(""); });

$("#deleteBtn").addEventListener("click", async () => {
  if (previewGuard()) return;
  const rec = spends.find((s) => s.id === editingId);
  if (!rec) return;
  if (!confirm(`刪除「${rec.vendor} ${fmt(rec.amount, rec.currency)}」呢筆？`)) return;
  await deleteSpend(rec.id);
  resetForm();
  closeDialog(spendDialog);
  setStatus("已刪除。");
  await refresh();
});

$("#recentList").addEventListener("click", (e) => {
  if (e.target.closest("[data-act='add-first']")) { openAdd(); return; }
  const row = e.target.closest(".spend-row");
  const rec = row && spends.find((s) => s.id === row.dataset.id);
  if (rec) openEdit(rec);
});

$("#moreRecent").addEventListener("click", () => { showAllRecent = !showAllRecent; renderList(); });

// legend ↔ doughnut highlighting is bound inside js/stats.js (Chart.js
// active elements), since the chart instance lives there.

// ----- month navigation -----
// The header itself carries no arrows: one pill shows the current month.
// Tapping it opens the picker panel, and only there do the ‹ › steppers
// (and the native month input) appear.
monthButton.addEventListener("click", () => setMonthPanel(monthPanel.hidden));
$("#monthDoneBtn").addEventListener("click", () => { setMonthPanel(false); monthButton.focus(); });
$("#thisMonthBtn").addEventListener("click", () => {
  monthInput.value = monthKeyOf(todayISO());
  renderDashboard();
  setMonthPanel(false);
  monthButton.focus();
});
document.addEventListener("click", (e) => {
  if (!monthPanel.hidden && !e.target.closest(".month-nav")) setMonthPanel(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !monthPanel.hidden) { setMonthPanel(false); monthButton.focus(); }
});
monthInput.addEventListener("change", () => { renderDashboard(); setMonthPanel(false); });
$("#prevMonth").addEventListener("click", () => { monthInput.value = prevMonthKey(currentKey()); renderDashboard(); });
$("#nextMonth").addEventListener("click", () => { monthInput.value = shiftMonthKey(currentKey(), 1); renderDashboard(); });

// keyboard access for the <label for=file> button (pick import file);
// the scan control is a native <button>, so it is keyboard-accessible as-is
document.querySelectorAll("label[for][role=button]").forEach((l) => l.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); document.getElementById(l.htmlFor)?.click(); }
}));

// ----- account + cloud sync -----
// Local-first: this whole layer is optional. Signed out, the app behaves
// exactly as it always has; signed in, js/sync.js mirrors the local data to
// the user's account. Sign-out never touches local records.
let pendingDataRefresh = false;

const SYNC_STATUS_TEXT = {
  "signed-out": "未登入",
  idle: "待同步",
  syncing: "同步中…",
  synced: "已同步",
  offline: "離線 — 有網絡時會自動同步",
  error: "同步失敗 — 會再自動重試",
  "trial-ended": "試用已完 — 同步已暫停",
};
const AUTH_ERROR_TEXT = {
  "invalid-email": "電郵格式唔啱，檢查下再試。",
  invalid: "驗證碼格式唔啱。",
  "invalid-code": "驗證碼唔啱或者已過期 — 可以重新寄過。",
  "too-many-attempts": "試錯太多次喇 — 重新寄一封登入電郵再試。",
  "rate-limited": "太密喇 — 等幾分鐘再試。",
  "send-failed": "電郵寄唔出 — 陣間再試。",
  "not-configured": "登入服務未設定好 — 陣間再試。",
  "invalid-token": "呢條登入連結唔用得（可能已用過或已過期）— 重新寄一封再試。",
};

function renderAccount() {
  const { account, status } = sync.getState();
  $("#accountBtn").classList.toggle("is-in", !!account);
  const accountName = account ? `帳戶 · ${account.email}` : "帳戶 · 登入";
  $("#accountBtn").setAttribute("aria-label", accountName);
  $("#accountBtn").title = accountName;
  $("#accountSignedOut").hidden = !!account;
  $("#accountSignedIn").hidden = !account;
  if (account) {
    $("#accountEmailText").textContent = account.email;
    if (account.plan === "trial" && account.trialEndsAt) {
      const d = new Date(account.trialEndsAt);
      $("#accountPlanText").textContent =
        `免費試用中 — 雲端同步試用至 ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    } else {
      $("#accountPlanText").textContent = "免費試用已完 — 雲端同步已暫停，資料仍然存喺呢部裝置。";
    }
    $("#syncStatusText").textContent = SYNC_STATUS_TEXT[status] || status;
  }
  $("#trialBanner").hidden = !(account && account.plan !== "trial");
}

$("#accountBtn").addEventListener("click", () => {
  renderAccount();
  openDialog(accountDialog);
  sync.refreshAccount().then(renderAccount).catch(() => {});
});

$("#requestLinkBtn").addEventListener("click", async () => {
  const email = $("#accountEmail").value.trim();
  const msg = $("#accountMsg");
  if (!email) { msg.textContent = "入返你個電郵先。"; return; }
  const btn = $("#requestLinkBtn");
  btn.disabled = true;
  msg.textContent = "寄緊…";
  const r = await sync.requestLink(email).catch(() => ({ ok: false, error: "send-failed" }));
  btn.disabled = false;
  if (r.ok) {
    $("#codeWrap").hidden = false;
    msg.textContent = "登入電郵寄咗去你信箱 — 㩒入面條連結，或者喺下面入嗰 6 位驗證碼。兩樣都係 15 分鐘內有效。";
    setTimeout(() => $("#accountCode").focus(), 50);
  } else {
    msg.textContent = AUTH_ERROR_TEXT[r.error] || "出咗問題 — 陣間再試。";
  }
});

$("#verifyCodeBtn").addEventListener("click", async () => {
  const email = $("#accountEmail").value.trim();
  const code = $("#accountCode").value.trim();
  const msg = $("#accountMsg");
  const btn = $("#verifyCodeBtn");
  btn.disabled = true;
  const r = await sync.verifyCode(email, code).catch(() => ({ ok: false, error: "invalid-code" }));
  btn.disabled = false;
  if (r.ok) {
    msg.textContent = "";
    $("#codeWrap").hidden = true;
    $("#accountCode").value = "";
    renderAccount();
    setStatus("已登入 — 雲端同步開始咗。");
  } else {
    msg.textContent = AUTH_ERROR_TEXT[r.error] || "出咗問題 — 陣間再試。";
  }
});

$("#accountEmail").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#requestLinkBtn").click(); } });
$("#accountCode").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#verifyCodeBtn").click(); } });

$("#syncNowBtn").addEventListener("click", () => { sync.syncNow().then(renderAccount).catch(() => {}); });

$("#logoutBtn").addEventListener("click", async () => {
  await sync.logout().catch(() => {});
  renderAccount();
  setStatus("已登出 — 記錄仍然存喺呢部裝置。");
});

// ----- settings (OCR engine + Tesseract 字庫） -----
async function openSettings() {
  const ocr = await import("./ocr.js");
  const engine = ocr.getEngine();
  document.querySelectorAll('input[name="ocrEngine"]').forEach((r) => { r.checked = r.value === engine; });
  const quality = ocr.getQuality();
  document.querySelectorAll('input[name="ocrQuality"]').forEach((r) => { r.checked = r.value === quality; });
  // TextDetector availability gates its option — never a dead control
  const tdSupported = ocr.isTextDetectorSupported();
  $("#engineInputTextdetector").disabled = !tdSupported;
  $("#engineRowTextdetector").classList.toggle("is-disabled", !tdSupported);
  $("#textdetectorNote").textContent = tdSupported ? "裝置內置偵測，即時又唔使下載" : "此瀏覽器不支援";
  // quality sizes come from ocr.js (real first-scan figures), not hard-coded here
  const mb = ocr.OCR_DOWNLOAD_MB_BY_QUALITY;
  $("#qualityBestNote").textContent = `（約 ${mb.best} MB）`;
  $("#qualityFastNote").textContent = `（約 ${mb.fast} MB）`;
  // PP-OCRv5 is always selectable; its note reflects whether the
  // one-time model download already happened on this device
  $("#ppocrNote").textContent = ocr.isPpocrReady()
    ? "繁體收據最準（模型已下載，可離線使用）"
    : `繁體收據最準，第一次用要下載約 ${ocr.PPOCR_DOWNLOAD_MB} MB，之後離線可用`;
  openDialog(settingsDialog);
}

$("#settingsBtn").addEventListener("click", () => { openSettings().catch(() => {}); });

document.querySelectorAll('input[name="ocrEngine"]').forEach((r) =>
  r.addEventListener("change", async () => {
    if (!r.checked) return;
    const ocr = await import("./ocr.js");
    ocr.setEngine(r.value);
  }));
document.querySelectorAll('input[name="ocrQuality"]').forEach((r) =>
  r.addEventListener("change", async () => {
    if (!r.checked) return;
    const ocr = await import("./ocr.js");
    await ocr.setQuality(r.value);
  }));

// ----- receipt scan (OCR, lazy-loaded) -----
// status first, so every click gives visible feedback even before the OS picker opens
$("#scanButton").addEventListener("click", () => {
  setStatus("揀張收據相，或者影一張 📷");
  $("#receiptFile").click();
});

$("#receiptFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (previewGuard()) return;
  const prog = $("#ocrProgress");
  const bar = $("#ocrBar");
  const pct = $("#ocrPct");
  prog.hidden = false;
  bar.style.width = "0%";
  pct.textContent = "OCR…";
  let usedEngine = null;
  try {
    const { ocrImage, getQuality, getEngine, isPpocrReady } = await import("./ocr.js");
    const text = await ocrImage(file, (p) => {
      bar.style.width = `${p}%`;
      pct.textContent = `${p}%`;
    }, {
      // fires only when an engine actually starts a first-time download —
      // a Chrome 文字偵測 scan never shows this note and downloads nothing
      onDownload: (mb) => setStatus(`首次使用要下載 OCR 引擎（約 ${mb} MB），之後可離線使用`),
      onEngine: (info) => { usedEngine = info; },
    });
    const parsed = parseReceiptText(text);
    resetForm();
    if (parsed.vendor) $("#vendor").value = parsed.vendor;
    // != null, not truthy: a found total of exactly 0 (net-zero exchange)
    // must show as 0, while a cancelled slip's suppressed amount (null)
    // leaves the field blank behind the cancelled banner.
    if (parsed.amount != null) $("#amount").value = parsed.amount;
    if (parsed.currency) $("#currency").value = parsed.currency;
    if (parsed.category) $("#category").value = parsed.category;
    // Scan flow only (round 5): a missed date stays EMPTY with a visible
    // hint — never a silent today-default that looks like a confident
    // read. Manual entry keeps its today default (set by resetForm).
    if (parsed.date) $("#date").value = parsed.date;
    else { $("#date").value = ""; $("#dateHint").hidden = false; }
    $("#cancelledBanner").hidden = !parsed.cancelled;
    pendingSource = "ocr";
    $("#formTitle").textContent = "📷 核對收據";
    openDialog(spendDialog);
    // PP-OCRv5 escalation (auto engine only): if this parse is missing
    // the amount or the date, offer the tier-3 retry inside the dialog.
    // It never auto-downloads — the button states the ~34 MB cost until
    // the models are on the device.
    lastScan = { file, parsed };
    const incomplete = parsed.amount == null || !parsed.date;
    const showPpRetry = getEngine() === "auto" && incomplete &&
      !(usedEngine && usedEngine.engine === "ppocr");
    $("#ppRetryWrap").hidden = !showPpRetry;
    if (showPpRetry) {
      $("#ppRetryBtn").disabled = false;
      $("#ppRetryCost").hidden = isPpocrReady();
    }
    const qualityLabel = getQuality() === "fast" ? "快速字庫" : "最佳字庫";
    let engineNote = "";
    if (usedEngine && usedEngine.engine === "textdetector") engineNote = "已用 Chrome 文字偵測";
    else if (usedEngine && usedEngine.engine === "ppocr") engineNote = "已用 PP-OCRv5";
    else if (usedEngine && usedEngine.fellBack) engineNote = `Chrome 文字偵測讀唔到，已改用 Tesseract（${qualityLabel}）`;
    else if (usedEngine) engineNote = `已用 Tesseract（${qualityLabel}）`;
    setStatus(engineNote ? `${engineNote} — 核對後撳儲存。` : "已讀取收據 — 核對後撳儲存。");
  } catch (err) {
    setStatus(err.message || "OCR 失敗 — 可以手動入數。", true);
  } finally {
    prog.hidden = true;
  }
});

// ----- PP-OCRv5 escalation retry (inside the confirm dialog) -----
// Runs PP-OCR on the same image, re-parses with the same parser, and
// keeps whichever parse found MORE of {金額， 日期， 商戶}: a kept PP
// parse fills the fields it found (values the original parse had and
// PP missed are never deleted), the dialog stays open, and the status
// line says which parse won and why. One attempt per scan.
$("#ppRetryBtn").addEventListener("click", async () => {
  if (!lastScan || previewGuard()) return;
  const btn = $("#ppRetryBtn");
  const prog = $("#ocrProgress");
  const bar = $("#ocrBar");
  const pct = $("#ocrPct");
  btn.disabled = true;
  prog.hidden = false;
  bar.style.width = "0%";
  pct.textContent = "PP-OCRv5…";
  try {
    const { ocrWithPpocr } = await import("./ocr.js");
    const text = await ocrWithPpocr(lastScan.file, (p) => {
      bar.style.width = `${p}%`;
      pct.textContent = `${p}%`;
    });
    const ppParsed = parseReceiptText(text);
    const foundCount = (r) => [r.amount, r.date, r.vendor].filter((v) => v != null && v !== "").length;
    const prev = lastScan.parsed;
    if (foundCount(ppParsed) > foundCount(prev)) {
      const gained = [];
      if (ppParsed.amount != null && prev.amount == null) gained.push("金額");
      if (ppParsed.date && !prev.date) gained.push("日期");
      if (ppParsed.vendor && !prev.vendor) gained.push("商戶");
      if (ppParsed.vendor) $("#vendor").value = ppParsed.vendor;
      if (ppParsed.amount != null) $("#amount").value = ppParsed.amount;
      if (ppParsed.currency) $("#currency").value = ppParsed.currency;
      if (ppParsed.category) $("#category").value = ppParsed.category;
      if (ppParsed.date) { $("#date").value = ppParsed.date; $("#dateHint").hidden = true; }
      lastScan.parsed = {
        vendor: ppParsed.vendor || prev.vendor,
        amount: ppParsed.amount ?? prev.amount,
        currency: ppParsed.currency || prev.currency,
        date: ppParsed.date || prev.date,
        category: ppParsed.category || prev.category,
      };
      setStatus(gained.length
        ? `PP-OCRv5 搵到${gained.join("同")}，已更新 — 核對後撳儲存。`
        : "PP-OCRv5 結果更完整，已更新 — 核對後撳儲存。");
    } else {
      setStatus("PP-OCRv5 結果冇更好，保留原本辨識 — 核對後撳儲存。");
    }
    // A cancelled slip stays cancelled whichever parse won: show the
    // banner and clear any amount — the user types one only deliberately.
    if (ppParsed.cancelled) {
      $("#cancelledBanner").hidden = false;
      $("#amount").value = "";
    }
    $("#ppRetryWrap").hidden = true;
  } catch (err) {
    btn.disabled = false;
    setStatus((err.message || "PP-OCRv5 失敗") + " — 可以再試，或者手動入數。", true);
  } finally {
    prog.hidden = true;
  }
});

// ----- file import (CSV / JSON / HTML) -----
function detectImportFormat(name, text) {
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  if (ext === "json") return "json";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "csv") return "csv";
  const t = String(text).trimStart();
  if (t.startsWith("<")) return "html";
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  return "csv";
}

$("#csvImportButton").addEventListener("click", () => openDialog(importDialog));

$("#csvFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (previewGuard()) return;
  closeDialog(importDialog);
  try {
    const text = await file.text();
    const format = detectImportFormat(file.name, text);
    let rows;
    if (format === "json") rows = parseJSON(text);
    else if (format === "html") rows = parseHTML(text);
    else rows = parseCSV(text);
    const label = format.toUpperCase();
    if (!rows.length) { setStatus(`${label} 入面搵唔到有效記錄（要日期 + 金額）。`, true); return; }
    // currency resolution: row's own value → UI override → format default
    // (HTML imports are saved Japanese order pages → JPY; CSV/JSON → HKD)
    const overrideSel = $("#importCurrency")?.value;
    const override = overrideSel && overrideSel !== "auto" ? overrideSel : null;
    const fallback = format === "html" ? "JPY" : "HKD";
    const resolved = rows.map((r) => ({
      ...r,
      currency: r.currency || override || fallback,
      category: r.category || "購物",
    }));
    const { toAdd, skipped } = filterNewRecords(spends, resolved);
    if (toAdd.length) {
      await addManySpends(toAdd.map((r) => ({ ...r, source: format })));
      await refresh();
    }
    setStatus(`${label} 匯入：新增 ${toAdd.length} 筆，跳過 ${skipped} 筆重複。`);
  } catch (err) {
    setStatus("匯入失敗：" + (err.message || err), true);
  }
});

// ----- CSV export -----
$("#exportBtn").addEventListener("click", () => {
  if (previewGuard()) return;
  if (!spends.length) { setStatus("冇記錄可以匯出。", true); return; }
  const head = "date,vendor,amount,currency,category,note,source";
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = spends.map((r) => [r.date, cell(r.vendor), Number(r.amount).toFixed(2), r.currency, cell(r.category), cell(r.note || ""), r.source].join(","));
  const blob = new Blob(["﻿" + head + "\n" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "onespends-export.csv";
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`已匯出 ${spends.length} 筆 → onespends-export.csv`);
});

// ----- init -----
// Boot order is deliberate: the boot-critical UI state (category options,
// the month picker's value, the form defaults) is set FIRST and each
// optional layer is failure-isolated. A throw in the stats layer must
// never present as a dead app — unset month input, no glance card, dead
// chips — which is exactly the failure this ordering guards against.
(async function init() {
  try {
    $("#category").innerHTML = `<option value="未分類">${catIcon("未分類")} 未分類</option>` +
      CATEGORIES.map((c) => `<option value="${c}">${catIcon(c)} ${c}</option>`).join("");
  } catch { /* non-fatal: the form simply keeps its markup options */ }
  monthInput.value = monthKeyOf(todayISO());
  resetForm();
  try {
    initStats({ fmt, fmtNum, esc, catIcon, catSlot });
  } catch { /* stats layer is optional — the app must still boot */ }
  try {
    const demo = await prepareDataSource();
    isDemoSession = demo;
    $("#demoBadge").hidden = !demo;
    await refresh();
  } catch (err) {
    setStatus("資料庫開唔到：" + (err.message || err), true);
  }
  // Account + sync layer: failure-isolated like the stats layer — a dead
  // network or API must never present as a dead app.
  try {
    sync.initSync({
      enabled: () => !isDemoSession && !previewActive,
      onState: () => renderAccount(),
      onData: () => {
        if (previewActive) { pendingDataRefresh = true; return; }
        refresh().catch(() => {});
      },
    });
    const viaLink = await sync.handleMagicLinkFromUrl().catch(() => false);
    if (viaLink) setStatus("已登入 — 雲端同步開始咗。");
    renderAccount();
  } catch { /* account layer is optional — the local app must still boot */ }
  // Boot beacon for the watchdog in app.html: only set once init has run
  // to completion. If the module graph dies before this point, the
  // watchdog offers the user a one-tap cache-clear + reload recovery.
  window.__onespendsBooted = true;
  if (resolveReady) resolveReady();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
})();
