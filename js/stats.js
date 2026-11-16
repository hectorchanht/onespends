// OneSpends — statistics + Chart.js rendering.
//
// Aggregation helpers in the first half are pure (no DOM) and are unit-tested
// in Node. Chart.js itself is vendored under ../vendor/chart/ and is loaded
// lazily by script injection only when a chart first renders, so the app's
// first paint never waits for it.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

const pad2 = (n) => String(n).padStart(2, "0");

export function isoOf(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function utcMsOfISO(iso) {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}

export function daysInRange(range) {
  return Math.round((utcMsOfISO(range.end) - utcMsOfISO(range.start)) / DAY_MS) + 1;
}

function isoFromUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDaysISO(iso, days) {
  return isoFromUTC(utcMsOfISO(iso) + days * DAY_MS);
}

function monthStartISO(year, monthIndex) {
  return `${year}-${pad2(monthIndex + 1)}-01`;
}

// The statistics range is anchored to TODAY. It deliberately does not read
// or follow the dashboard's month navigation: the dashboard answers "this
// month at a glance", while 統計 answers "this chosen period".
export function getPresetRange(preset, today = new Date()) {
  const end = isoOf(today);
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (preset) {
    case "prevMonth": {
      const first = new Date(y, m - 1, 1);
      const last = new Date(y, m, 0);
      return { preset, start: isoOf(first), end: isoOf(last) };
    }
    case "7d":
      return { preset, start: addDaysISO(end, -6), end };
    case "30d":
      return { preset, start: addDaysISO(end, -29), end };
    case "3m":
      return { preset, start: monthStartISO(y, m - 2), end };
    case "year":
      return { preset, start: `${y}-01-01`, end };
    case "month":
    default:
      return { preset: "month", start: monthStartISO(y, m), end };
  }
}

export function normalizeCustomRange(start, end) {
  if (!start && !end) return null;
  let s = start || end;
  let e = end || start;
  let clamped = false;
  if (e < s) {
    e = s;
    clamped = true;
  }
  return { preset: "custom", start: s, end: e, clamped };
}

export function previousRange(range) {
  const days = daysInRange(range);
  const end = addDaysISO(range.start, -1);
  const start = addDaysISO(end, -(days - 1));
  return { preset: "previous", start, end };
}

export function recordsInRange(records, range) {
  return records.filter((r) => r.date >= range.start && r.date <= range.end);
}

export function currencySummary(records) {
  const map = new Map();
  for (const r of records) {
    const cur = map.get(r.currency) || { currency: r.currency, count: 0, total: 0 };
    cur.count += 1;
    cur.total += Number(r.amount) || 0;
    map.set(r.currency, cur);
  }
  return [...map.values()].sort((a, b) =>
    b.count - a.count || b.total - a.total || a.currency.localeCompare(b.currency));
}

export function chooseCurrency(records, preferred) {
  const summaries = currencySummary(records);
  if (!summaries.length) return "";
  if (preferred && summaries.some((s) => s.currency === preferred)) return preferred;
  return summaries[0].currency;
}

function trendBuckets(records, range) {
  const days = daysInRange(range);
  if (days <= 31) {
    const labels = [];
    const titles = [];
    const values = [];
    const sums = new Map();
    for (const r of records) sums.set(r.date, (sums.get(r.date) || 0) + Number(r.amount));
    for (let i = 0; i < days; i++) {
      const iso = addDaysISO(range.start, i);
      const d = new Date(iso + "T00:00:00");
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
      titles.push(iso);
      values.push(sums.get(iso) || 0);
    }
    return { kind: "daily", labels, titles, values };
  }

  const sums = new Map();
  for (const r of records) {
    const key = r.date.slice(0, 7);
    sums.set(key, (sums.get(key) || 0) + Number(r.amount));
  }
  const labels = [];
  const titles = [];
  const values = [];
  let y = +range.start.slice(0, 4);
  let m = +range.start.slice(5, 7) - 1;
  const endY = +range.end.slice(0, 4);
  const endM = +range.end.slice(5, 7) - 1;
  while (y < endY || (y === endY && m <= endM)) {
    const key = `${y}-${pad2(m + 1)}`;
    labels.push(y === endY && y === +range.start.slice(0, 4) ? `${m + 1}月` : `${key}`);
    titles.push(key);
    values.push(sums.get(key) || 0);
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  return { kind: "monthly", labels, titles, values };
}

export function aggregateStats(records, currency, range) {
  const current = recordsInRange(records, range).filter((r) => r.currency === currency);
  const prevR = previousRange(range);
  const previous = recordsInRange(records, prevR).filter((r) => r.currency === currency);
  const total = current.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const prevTotal = previous.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  const days = daysInRange(range);
  const maxRecord = current.reduce((best, r) =>
    !best || Number(r.amount) > Number(best.amount) ? r : best, null);

  const catMap = new Map();
  for (const r of current) {
    const item = catMap.get(r.category) || { category: r.category, amount: 0, count: 0 };
    item.amount += Number(r.amount) || 0;
    item.count += 1;
    catMap.set(r.category, item);
  }
  const categories = [...catMap.values()]
    .map((item) => ({ ...item, share: total ? item.amount / total : 0 }))
    .sort((a, b) => b.amount - a.amount || b.count - a.count || a.category.localeCompare(b.category));

  const vendorMap = new Map();
  for (const r of current) {
    const item = vendorMap.get(r.vendor) || { vendor: r.vendor, amount: 0, count: 0 };
    item.amount += Number(r.amount) || 0;
    item.count += 1;
    vendorMap.set(r.vendor, item);
  }
  const vendors = [...vendorMap.values()]
    .sort((a, b) => b.amount - a.amount || b.count - a.count || a.vendor.localeCompare(b.vendor))
    .slice(0, 5);

  const weekday = Array(7).fill(0);
  for (const r of current) {
    const day = new Date(r.date + "T00:00:00").getDay(); // Sun=0 … Sat=6
    weekday[(day + 6) % 7] += Number(r.amount) || 0; // → Mon=0 … Sun=6
  }

  return {
    currency,
    range,
    previousRange: prevR,
    records: current,
    previousRecords: previous,
    total,
    count: current.length,
    dailyAverage: days ? total / days : 0,
    dayCount: days,
    maxRecord,
    maxAmount: maxRecord ? Number(maxRecord.amount) : 0,
    previousTotal: prevTotal,
    previousCount: previous.length,
    deltaPct: previous.length && prevTotal !== 0 ? ((total - prevTotal) / prevTotal) * 100 : null,
    trend: trendBuckets(current, range),
    categories,
    categoriesTop: categories.slice(0, 8),
    vendors,
    weekday: { labels: [...WEEKDAY_LABELS], values: weekday },
  };
}

// ---------------- browser chart layer ----------------

let helpers = {
  fmt: (amount, currency) => `${currency} ${Number(amount).toFixed(2)}`,
  fmtNum: (amount) => String(amount),
  esc: (s) => String(s ?? ""),
  catIcon: () => "",
  catSlot: () => 9,
};

let lastDashboardArgs = null;
let colorSchemeBound = false;

export function initStats(nextHelpers) {
  helpers = { ...helpers, ...nextHelpers };
  bindStatsControls();
  bindDonutLegend();
  // Canvas charts snapshot the CSS-variable palette (unlike the old SVG,
  // which recoloured itself), so re-render with the fresh palette when the
  // OS colour scheme flips while the app is open.
  if (!colorSchemeBound && typeof window !== "undefined" && window.matchMedia) {
    colorSchemeBound = true;
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
      if (lastDashboardArgs) renderDashboardCharts(lastDashboardArgs).catch(() => {});
      if (statsState.spends.length) renderStats(statsState.spends).catch(() => {});
    });
  }
}

let chartLoadPromise = null;
let chartLoadFailed = false;

export function loadChartJs() {
  if (typeof window !== "undefined" && window.Chart) return Promise.resolve(window.Chart);
  if (chartLoadPromise) return chartLoadPromise;
  chartLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL("../vendor/chart/chart.umd.min.js", import.meta.url).href;
    script.async = true;
    script.onload = () => {
      if (window.Chart) resolve(window.Chart);
      else { chartLoadFailed = true; reject(new Error("Chart.js 載入失敗")); }
    };
    script.onerror = () => { chartLoadFailed = true; reject(new Error("Chart.js 載入失敗")); };
    document.head.appendChild(script);
  });
  return chartLoadPromise;
}

function cssVar(name, fallback = "") {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}

function palette() {
  return {
    text: cssVar("--text", "#17211a"),
    muted: cssVar("--muted", "#5c6a60"),
    line: cssVar("--line", "#dde3dc"),
    card: cssVar("--card", "#ffffff"),
    brand: cssVar("--brand", "#166534"),
    brandStrong: cssVar("--brand-strong", "#14532d"),
    brandSoft: cssVar("--brand-soft", "#e7f2e9"),
    bar: cssVar("--bar", "#86c79b"),
    barToday: cssVar("--bar-today", "#14532d"),
    cat: (slot) => cssVar(`--cat-${slot}`, "#8b918c"),
  };
}

function configureChart(Chart) {
  const p = palette();
  const fontFamily = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = p.muted;
  Chart.defaults.borderColor = p.line;
  Chart.defaults.font.family = fontFamily;
  Chart.defaults.font.weight = 700;
  Chart.defaults.plugins.tooltip.backgroundColor = p.card;
  Chart.defaults.plugins.tooltip.titleColor = p.text;
  Chart.defaults.plugins.tooltip.bodyColor = p.text;
  Chart.defaults.plugins.tooltip.borderColor = p.line;
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.displayColors = false;
  return p;
}

const chartInstances = new Map();

function destroyChart(id) {
  const chart = chartInstances.get(id);
  if (chart) {
    chart.destroy();
    chartInstances.delete(id);
  }
}

function createChart(id, canvas, config) {
  destroyChart(id);
  const chart = new window.Chart(canvas.getContext("2d"), config);
  chartInstances.set(id, chart);
  return chart;
}

function setChartArea(container, id, heightClass = "") {
  if (!container) return null;
  container.innerHTML = `<div class="chart-box ${heightClass}"><canvas id="${id}" aria-label="圖表"></canvas></div>`;
  return container.querySelector("canvas");
}

function setChartMessage(container, message) {
  if (!container) return;
  container.innerHTML = `<p class="chart-empty">${helpers.esc(message)}</p>`;
}

function amountTooltip(currency) {
  return {
    callbacks: {
      label: (ctx) => `金額：${helpers.fmt(ctx.parsed.y ?? ctx.parsed ?? 0, currency)}`,
    },
  };
}

let dashboardSeq = 0;
let currentDonutChart = null;

export async function renderDashboardCharts(args) {
  const { spends: allSpends, thisMonth, primary, monthKey, today } = args;
  lastDashboardArgs = args;
  const seq = ++dashboardSeq;
  const donutWrap = document.querySelector("#donut");
  const barsWrap = document.querySelector("#bars");
  const legend = document.querySelector("#donutLegend");
  let Chart;
  try {
    Chart = await loadChartJs();
  } catch {
    if (seq !== dashboardSeq) return;
    setChartMessage(donutWrap, "圖表載入失敗");
    if (legend) legend.innerHTML = "";
    setChartMessage(barsWrap, "圖表載入失敗");
    return;
  }
  if (seq !== dashboardSeq) return;
  const p = configureChart(Chart);

  // --- category doughnut (current dashboard month + primary currency) ---
  const rows = thisMonth.filter((r) => r.currency === primary);
  const byCat = new Map();
  for (const r of rows) byCat.set(r.category, (byCat.get(r.category) || 0) + Number(r.amount));
  const total = [...byCat.values()].reduce((a, b) => a + b, 0);
  const segments = [...byCat.entries()].sort((a, b) => helpers.catSlot(a[0]) - helpers.catSlot(b[0]));
  document.querySelector("#donutCcy").textContent = primary || "";

  if (donutWrap) {
    const canvas = setChartArea(donutWrap, "donutChart", "donut-box");
    donutWrap.insertAdjacentHTML("beforeend",
      `<div class="donut-center" aria-hidden="true"><strong>${total ? helpers.esc(helpers.fmtNum(total, primary, true)) : "未有"}</strong><span>${helpers.esc(primary || "")}</span></div>`);
    if (canvas) {
      currentDonutChart = createChart("donutChart", canvas, {
        type: "doughnut",
        data: {
          labels: segments.length ? segments.map(([cat]) => cat) : ["未有記錄"],
          datasets: [{
            data: segments.length ? segments.map(([, amt]) => amt) : [1],
            backgroundColor: segments.length
              ? segments.map(([cat]) => p.cat(helpers.catSlot(cat)))
              : [p.brandSoft],
            borderColor: p.card,
            borderWidth: 2,
            hoverOffset: 7,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "67%",
          plugins: {
            legend: { display: false },
            tooltip: segments.length ? {
              callbacks: {
                label: (ctx) => {
                  const amt = ctx.parsed || 0;
                  const pct = total ? Math.round((amt / total) * 100) : 0;
                  return `${ctx.label}：${helpers.fmt(amt, primary)}（${pct}%）`;
                },
              },
            } : { enabled: false },
          },
        },
      });
    }
  }

  if (legend) {
    const chartIndex = new Map(segments.map(([cat], i) => [cat, i]));
    legend.innerHTML = [...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([cat, amt]) =>
      `<li class="legend-chip" data-cat="${helpers.esc(cat)}" data-chart-index="${chartIndex.get(cat)}" tabindex="0">
        <span class="swatch cat-${helpers.catSlot(cat)}"></span>
        <span class="lc-icon" aria-hidden="true">${helpers.catIcon(cat)}</span>
        <span class="lc-name">${helpers.esc(cat)}</span>
        <span class="lc-amt">${helpers.esc(helpers.fmtNum(amt, primary, true))}</span>
        <span class="lc-pct">${Math.round((amt / total) * 100)}%</span>
      </li>`).join("");
  }

  // --- last-7-days bars (same end-of-window rule as the old SVG version) ---
  document.querySelector("#barsCcy").textContent = primary || "";
  if (barsWrap) {
    let end;
    if (monthKey === today.slice(0, 7)) end = new Date(today + "T00:00:00");
    else {
      const [y, m] = monthKey.split("-").map(Number);
      end = new Date(y, m, 0);
    }
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
      days.push({ iso: isoOf(d), d });
    }
    const sums = new Map(days.map((x) => [x.iso, 0]));
    for (const r of allSpends) {
      if (r.currency === primary && sums.has(r.date)) sums.set(r.date, sums.get(r.date) + Number(r.amount));
    }
    const values = days.map((x) => sums.get(x.iso));
    if (!values.some((v) => v > 0)) {
      destroyChart("barsChart");
      setChartMessage(barsWrap, "最近 7 日未有使費");
    } else {
      const canvas = setChartArea(barsWrap, "barsChart", "bars-box");
      if (canvas) {
        createChart("barsChart", canvas, {
          type: "bar",
          data: {
            labels: days.map((x) => [x.iso === today ? "今日" : ["日", "一", "二", "三", "四", "五", "六"][x.d.getDay()], `${x.d.getMonth() + 1}/${x.d.getDate()}`]),
            datasets: [{
              data: values,
              backgroundColor: days.map((x) => x.iso === today ? p.barToday : p.bar),
              borderRadius: 5,
              maxBarThickness: 34,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  title: (items) => days[items[0].dataIndex].iso,
                  label: (ctx) => `金額：${helpers.fmt(ctx.parsed.y || 0, primary)}`,
                },
              },
            },
            scales: {
              x: { grid: { display: false } },
              y: {
                beginAtZero: true,
                ticks: { callback: (v) => helpers.fmtNum(v, primary, true), maxTicksLimit: 5 },
                grid: { color: p.line },
              },
            },
          },
        });
      }
    }
  }
}

function bindDonutLegend() {
  const legend = document.querySelector("#donutLegend");
  if (!legend || legend.dataset.chartBound === "1") return;
  legend.dataset.chartBound = "1";
  const activate = (chip) => {
    if (!chip || !currentDonutChart) return;
    const index = Number(chip.dataset.chartIndex);
    if (!Number.isInteger(index)) return;
    const active = [{ datasetIndex: 0, index }];
    currentDonutChart.setActiveElements(active);
    currentDonutChart.tooltip?.setActiveElements(active, { x: 0, y: 0 });
    currentDonutChart.update();
  };
  const clear = () => {
    if (!currentDonutChart) return;
    currentDonutChart.setActiveElements([]);
    currentDonutChart.tooltip?.setActiveElements([], { x: 0, y: 0 });
    currentDonutChart.update();
  };
  legend.addEventListener("mouseover", (e) => activate(e.target.closest(".legend-chip")));
  legend.addEventListener("mouseleave", clear);
  legend.addEventListener("focusin", (e) => activate(e.target.closest(".legend-chip")));
  legend.addEventListener("focusout", clear);
}

// ---------------- statistics section ----------------

// Range state is in-memory only (never localStorage): it survives the
// re-renders of one session and resets on the next visit.
export const statsState = {
  preset: "month",
  customStart: "",
  customEnd: "",
  customClamped: false,
  currency: "",
  currencyChosen: false,
  spends: [],
  controlsBound: false,
};

function currentStatsRange() {
  if (statsState.preset === "custom") {
    const normalized = normalizeCustomRange(statsState.customStart, statsState.customEnd);
    if (normalized) {
      statsState.customClamped = normalized.clamped;
      if (normalized.clamped) statsState.customEnd = normalized.end;
      return normalized;
    }
  }
  statsState.customClamped = false;
  return getPresetRange(statsState.preset);
}

function bindStatsControls() {
  if (statsState.controlsBound || typeof document === "undefined") return;
  const section = document.querySelector("#statsSection");
  if (!section) return;
  statsState.controlsBound = true;

  section.querySelectorAll("[data-range-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      statsState.preset = btn.dataset.rangePreset;
      if (statsState.preset === "custom" && !statsState.customStart && !statsState.customEnd) {
        const month = getPresetRange("month");
        statsState.customStart = month.start;
        statsState.customEnd = month.end;
      }
      renderStats(statsState.spends);
    });
  });
  const startInput = document.querySelector("#statsStart");
  const endInput = document.querySelector("#statsEnd");
  const onCustomChange = () => {
    statsState.preset = "custom";
    statsState.customStart = startInput.value;
    statsState.customEnd = endInput.value;
    renderStats(statsState.spends);
  };
  startInput?.addEventListener("change", onCustomChange);
  endInput?.addEventListener("change", onCustomChange);

  document.querySelector("#statsCurrencyChips")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-stats-currency]");
    if (!btn) return;
    statsState.currency = btn.dataset.statsCurrency;
    statsState.currencyChosen = true;
    renderStats(statsState.spends);
  });
}

function syncStatsControls(range, summaries) {
  document.querySelectorAll("[data-range-preset]").forEach((btn) => {
    const active = btn.dataset.rangePreset === statsState.preset;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
  const customWrap = document.querySelector("#statsCustomRange");
  if (customWrap) customWrap.hidden = statsState.preset !== "custom";
  const startInput = document.querySelector("#statsStart");
  const endInput = document.querySelector("#statsEnd");
  if (startInput) startInput.value = statsState.customStart || range.start;
  if (endInput) endInput.value = statsState.customEnd || range.end;
  const hint = document.querySelector("#statsRangeHint");
  if (hint) {
    hint.textContent = statsState.customClamped
      ? "結束日期早過開始日期，已自動調整為開始日期。"
      : `${range.start} 至 ${range.end}，共 ${daysInRange(range)} 日`;
  }
  const chips = document.querySelector("#statsCurrencyChips");
  if (chips) {
    chips.hidden = summaries.length <= 1;
    chips.innerHTML = summaries.map((s) =>
      `<button type="button" class="range-chip currency-chip${s.currency === statsState.currency ? " is-active" : ""}" data-stats-currency="${helpers.esc(s.currency)}" aria-pressed="${s.currency === statsState.currency}">${helpers.esc(s.currency)} · ${s.count} 筆</button>`).join("");
  }
}

let statsSeq = 0;

export async function renderStats(allSpends) {
  statsState.spends = allSpends || [];
  const seq = ++statsSeq;
  const range = currentStatsRange();
  const inRange = recordsInRange(statsState.spends, range);
  const summaries = currencySummary(inRange);
  statsState.currency = chooseCurrency(inRange, statsState.currencyChosen ? statsState.currency : "");
  syncStatsControls(range, summaries);

  const ccyTag = document.querySelector("#statsCcy");
  if (ccyTag) ccyTag.textContent = statsState.currency || "";
  const strip = document.querySelector("#statsStrip");
  const trendWrap = document.querySelector("#trendChartWrap");
  const rankWrap = document.querySelector("#categoryRankWrap");
  const weekdayWrap = document.querySelector("#weekdayChartWrap");
  const vendorsEl = document.querySelector("#topVendors");

  if (!summaries.length || !statsState.currency) {
    destroyChart("trendChart");
    destroyChart("categoryRankChart");
    destroyChart("weekdayChart");
    if (strip) strip.innerHTML = `<p class="stats-empty">呢段期間未有記錄。</p>`;
    setChartMessage(trendWrap, "呢段期間未有記錄，未有趨勢圖。");
    setChartMessage(rankWrap, "呢段期間未有記錄，未有分類排行。");
    setChartMessage(weekdayWrap, "呢段期間未有記錄，未有星期分布。");
    if (vendorsEl) vendorsEl.innerHTML = `<li class="vendor-empty">呢段期間未有記錄。</li>`;
    return;
  }

  const agg = aggregateStats(statsState.spends, statsState.currency, range);
  const cur = agg.currency;
  if (strip) {
    let deltaHtml;
    if (agg.deltaPct === null) {
      deltaHtml = `<div class="stat-card delta-card"><span class="stat-label">同上一段比較</span><strong>—</strong><small>上一段冇記錄</small></div>`;
    } else {
      const cls = agg.deltaPct > 0 ? "up" : agg.deltaPct < 0 ? "down" : "flat";
      const arrow = agg.deltaPct > 0 ? "▲" : agg.deltaPct < 0 ? "▼" : "＝";
      deltaHtml = `<div class="stat-card delta-card"><span class="stat-label">同上一段比較</span><strong class="delta ${cls}">${arrow} ${Math.abs(agg.deltaPct).toFixed(1)}%</strong><small>上一段 ${helpers.esc(helpers.fmt(agg.previousTotal, cur))}</small></div>`;
    }
    strip.innerHTML = `
      <div class="stat-card"><span class="stat-label">範圍總額</span><strong>${helpers.esc(helpers.fmt(agg.total, cur))}</strong><small>${agg.range.start} 至 ${agg.range.end}</small></div>
      <div class="stat-card"><span class="stat-label">每日平均</span><strong>${helpers.esc(helpers.fmt(agg.dailyAverage, cur))}</strong><small>共 ${agg.dayCount} 日</small></div>
      <div class="stat-card"><span class="stat-label">筆數</span><strong>${agg.count}</strong><small>筆記錄</small></div>
      <div class="stat-card"><span class="stat-label">最大單筆</span><strong>${helpers.esc(helpers.fmt(agg.maxAmount, cur))}</strong><small>${agg.maxRecord ? helpers.esc(agg.maxRecord.vendor) : "—"}</small></div>
      ${deltaHtml}`;
  }

  if (vendorsEl) {
    vendorsEl.innerHTML = agg.vendors.length ? agg.vendors.map((v, i) =>
      `<li class="vendor-row"><span class="vendor-rank">${i + 1}</span><span class="vendor-main"><strong>${helpers.esc(v.vendor)}</strong><small>${v.count} 筆</small></span><span class="vendor-amt">${helpers.esc(helpers.fmt(v.amount, cur))}</span></li>`).join("")
      : `<li class="vendor-empty">呢段期間未有商戶記錄。</li>`;
  }

  let Chart;
  try {
    Chart = await loadChartJs();
  } catch {
    if (seq !== statsSeq) return;
    setChartMessage(trendWrap, "圖表載入失敗");
    setChartMessage(rankWrap, "圖表載入失敗");
    setChartMessage(weekdayWrap, "圖表載入失敗");
    return;
  }
  if (seq !== statsSeq) return;
  const p = configureChart(Chart);
  const todayIso = isoOf(new Date());

  // Trend — daily buckets ≤31 days, monthly buckets beyond that.
  if (trendWrap) {
    if (!agg.total) {
      destroyChart("trendChart");
      setChartMessage(trendWrap, "呢段期間未有使費，未有趨勢圖。");
    } else {
      const canvas = setChartArea(trendWrap, "trendChart", "trend-box");
      if (canvas) createChart("trendChart", canvas, {
        type: "bar",
        data: {
          labels: agg.trend.labels,
          datasets: [{
            data: agg.trend.values,
            backgroundColor: agg.trend.titles.map((t) =>
              (agg.trend.kind === "daily" ? t === todayIso : t === todayIso.slice(0, 7)) ? p.barToday : p.bar),
            borderRadius: 5,
            maxBarThickness: 34,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              title: (items) => agg.trend.titles[items[0].dataIndex],
              label: (ctx) => `金額：${helpers.fmt(ctx.parsed.y || 0, cur)}`,
            } },
          },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } },
            y: { beginAtZero: true, ticks: { callback: (v) => helpers.fmtNum(v, cur, true), maxTicksLimit: 5 }, grid: { color: p.line } },
          },
        },
      });
    }
  }

  // Category ranking — top 8, horizontal.
  if (rankWrap) {
    if (!agg.categoriesTop.length) {
      destroyChart("categoryRankChart");
      setChartMessage(rankWrap, "呢段期間未有分類記錄。");
    } else {
      const canvas = setChartArea(rankWrap, "categoryRankChart", "rank-box");
      if (canvas) createChart("categoryRankChart", canvas, {
        type: "bar",
        data: {
          labels: agg.categoriesTop.map((c) => `${helpers.catIcon(c.category)} ${c.category}`),
          datasets: [{
            data: agg.categoriesTop.map((c) => c.amount),
            backgroundColor: agg.categoriesTop.map((c) => p.cat(helpers.catSlot(c.category))),
            borderRadius: 5,
            maxBarThickness: 24,
          }],
        },
        options: {
          indexAxis: "y",
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              label: (ctx) => {
                const item = agg.categoriesTop[ctx.dataIndex];
                return `金額：${helpers.fmt(item.amount, cur)}（${Math.round(item.share * 100)}%）`;
              },
            } },
          },
          scales: {
            x: { beginAtZero: true, ticks: { callback: (v) => helpers.fmtNum(v, cur, true), maxTicksLimit: 5 }, grid: { color: p.line } },
            y: { grid: { display: false } },
          },
        },
      });
    }
  }

  // Weekday pattern — Monday first.
  if (weekdayWrap) {
    if (!agg.total) {
      destroyChart("weekdayChart");
      setChartMessage(weekdayWrap, "呢段期間未有使費，未有星期分布。");
    } else {
      const canvas = setChartArea(weekdayWrap, "weekdayChart", "weekday-box");
      const maxWeekday = Math.max(...agg.weekday.values);
      if (canvas) createChart("weekdayChart", canvas, {
        type: "bar",
        data: {
          labels: agg.weekday.labels,
          datasets: [{
            data: agg.weekday.values,
            backgroundColor: agg.weekday.values.map((v) => v === maxWeekday && v > 0 ? p.barToday : p.bar),
            borderRadius: 5,
            maxBarThickness: 34,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: amountTooltip(cur),
          },
          scales: {
            x: { grid: { display: false } },
            y: { beginAtZero: true, ticks: { callback: (v) => helpers.fmtNum(v, cur, true), maxTicksLimit: 5 }, grid: { color: p.line } },
          },
        },
      });
    }
  }
}

export function resetStatsCurrencyChoice() {
  statsState.currencyChosen = false;
}
