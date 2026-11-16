// OneSpends — first-visit guided tour, powered by Driver.js (vendored, MIT).
// Positioning / spotlight / popover are all handled by the library
// (vendor/driver.js); this file only supplies steps, texts and lifecycle.
// It silently does nothing if the library or a target is unavailable.
//
// Flow: the tour opens in PREVIEW. window.OneSpendsPreview (js/app.js) swaps
// the dashboard to the fictional demo dataset at the render layer only —
// nothing is written to the user's database — so a new user first sees the
// "finished look". The two preview steps walk that demo-filled dashboard;
// the moment the tour moves past them (or is dismissed), the preview is torn
// down and the original how-to steps run on the user's real UI.
(function () {
  "use strict";

  var STORAGE_KEY = "onespends_tour_seen";

  // Shown over the demo-filled dashboard (preview on).
  var PREVIEW_STEP_DEFS = [
    {
      selector: "#glanceCards",
      title: "入咗資料之後，就係呢個樣",
      text: "而家你睇到嘅係示範數據：記低使費之後，每隻貨幣一張卡，本月總額一眼睇晒，仲會同上月比較升跌。唔同貨幣分開計，唔會溝埋做一個假總數。"
    },
    {
      selector: "#chartsGrid",
      title: "同一批數，幾種睇法",
      text: "分類圓環睇本月啲錢使咗喺邊一類，最近 7 日柱狀圖睇每日走勢，今日會特別標示。撳上面個月份掣，會開個日期選擇器，喺入面用 ‹ › 逐個月慢慢睇都得。"
    }
  ];

  var STEP_DEFS = [
    {
      selector: "#glanceCards",
      title: "一眼睇晒",
      text: "每隻貨幣一張卡：本月總額，加埋比上月升（▲）定跌（▼）幾多 %。不同貨幣不會溝埋計。"
    },
    {
      selector: "#chartsGrid",
      title: "分類同最近 7 日",
      text: "圓環圖睇本月錢使咗喺邊類；柱狀圖睇最近 7 日每日使幾多，今日會用深色標示。撳上面個月份掣開日期選擇器，就可以轉月份。"
    },
    {
      selector: "#scanButton",
      title: "影一張收據",
      text: "撳 📷 影相或揀相。OCR 會在這部裝置讀取資料，再預填表格等你核對，唔會自動入數。"
    },
    {
      selector: "#addBtn",
      title: "幾秒手動加數",
      text: "撳 ＋ 輸入商戶、金額、日期同分類就儲存到；撳「最近」入面任何一筆就可以編輯或刪除。"
    },
    {
      selector: "#csvImportButton",
      title: "匯入 statement",
      text: "撳 ⬆ 匯入銀行或付款 app 的 CSV / JSON / HTML。OneSpends 會自動辨認欄位，亦會跳過重複記錄。"
    },
    {
      selector: "#exportBtn",
      title: "匯出同私隱",
      text: "撳 ⬇ 將全部記錄匯出成 CSV 備份。免費版不設帳戶，你的記錄只存喺這部裝置。"
    }
  ];

  var driverObj = null;
  var previewTour = false; // this run includes the preview steps
  var previewOn = false;   // preview is currently rendered
  var previewCount = 0;    // how many preview steps made the step list

  function storageGet() {
    try { return window.localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }

  function storageSet() {
    try { window.localStorage.setItem(STORAGE_KEY, "1"); } catch (e) { /* private mode: tour simply remains available */ }
  }

  function driverFactory() {
    // Vendored IIFE build: window.driver.js is the module, .driver is the factory.
    if (window.driver && window.driver.js && typeof window.driver.js.driver === "function") {
      return window.driver.js.driver;
    }
    return null;
  }

  function previewApi() {
    var api = window.OneSpendsPreview;
    return (api && typeof api.enter === "function" && typeof api.exit === "function") ? api : null;
  }

  function refreshSoon() {
    window.requestAnimationFrame(function () {
      if (driverObj && typeof driverObj.refresh === "function") {
        try { driverObj.refresh(); } catch (e) { /* layout settles on next scroll/resize anyway */ }
      }
    });
  }

  // Restore the real dashboard. Safe to call from any exit path, any times.
  function endPreview() {
    if (!previewOn) return;
    previewOn = false;
    var api = previewApi();
    if (api) { try { api.exit(); } catch (e) { /* app restores itself on next render */ } }
    refreshSoon();
  }

  function enterPreviewAgain() {
    if (previewOn) return;
    var api = previewApi();
    if (!api) return;
    try { if (api.enter()) { previewOn = true; refreshSoon(); } } catch (e) { /* stay on real UI */ }
  }

  // Only build steps for targets that exist and are rendered right now —
  // Driver.js then never points at a hidden or missing element.
  function buildSteps(withPreview) {
    var defs = withPreview ? PREVIEW_STEP_DEFS.concat(STEP_DEFS) : STEP_DEFS;
    var out = [];
    var pCount = 0;
    for (var i = 0; i < defs.length; i++) {
      var def = defs[i];
      var el = document.querySelector(def.selector);
      if (el && el.getClientRects().length) {
        out.push({
          element: def.selector,
          __tourIndex: out.length,
          popover: { title: def.title, description: def.text }
        });
        if (withPreview && i < PREVIEW_STEP_DEFS.length) pCount++;
      }
    }
    return { steps: out, previewCount: pCount };
  }

  function activeIndexOf(step, opts) {
    if (opts && opts.state && typeof opts.state.activeIndex === "number") return opts.state.activeIndex;
    if (step && typeof step.__tourIndex === "number") return step.__tourIndex;
    return -1;
  }

  function begin(withPreview) {
    var factory = driverFactory();
    if (!factory) { if (withPreview) endPreview(); return; }
    var built = buildSteps(withPreview);
    if (withPreview && built.previewCount === 0) {
      // Preview rendered but its targets are missing — fall back to the
      // plain tour on the real UI rather than stranding the demo data.
      endPreview();
      withPreview = false;
      built = buildSteps(false);
    }
    if (!built.steps.length) { if (withPreview) endPreview(); return; }
    previewTour = withPreview;
    previewCount = built.previewCount;

    driverObj = factory({
      animate: true,
      smoothScroll: true,
      showProgress: true,
      progressText: "第 {{current}} 步，共 {{total}} 步",
      nextBtnText: "下一步",
      prevBtnText: "上一步",
      doneBtnText: "完成",
      popoverClass: "onespends-popover",
      steps: built.steps,
      // Preview lives only for the preview steps: crossing the boundary in
      // either direction swaps the dashboard between demo and real data.
      onHighlightStarted: function (element, step, opts) {
        if (!previewTour) return;
        var idx = activeIndexOf(step, opts);
        if (idx < 0) return;
        if (idx < previewCount) enterPreviewAgain();
        else endPreview();
      },
      // Fires on 完成, on the close button and on overlay-click dismissal —
      // every exit path tears the preview down and counts as "seen".
      onDestroyed: function () { endPreview(); storageSet(); }
    });
    driverObj.drive();
  }

  function start() {
    try {
      if (!driverFactory()) return;
      if (driverObj && driverObj.isActive()) driverObj.destroy();
      var api = previewApi();
      if (!api) { begin(false); return; }

      // Wait for the app's first render, otherwise preview would snapshot a
      // not-yet-loaded dashboard and restore the wrong thing afterwards.
      var settled = false;
      var goPreview = function () {
        if (settled) return;
        settled = true;
        var ok = false;
        try { ok = !!api.enter(); } catch (e) { ok = false; }
        if (ok) previewOn = true;
        begin(ok);
      };
      var goPlain = function () {
        if (settled) return;
        settled = true;
        begin(false);
      };
      var ready = (typeof api.whenReady === "function") ? api.whenReady() : null;
      if (ready && typeof ready.then === "function") {
        ready.then(goPreview, goPreview);
        window.setTimeout(goPlain, 2500); // app never became ready: plain tour
      } else {
        goPreview();
      }
    } catch (e) {
      // A tour must never interfere with the app itself.
    }
  }

  function bindReplayButtons() {
    var buttons = document.querySelectorAll("[data-tour-start]");
    Array.prototype.forEach.call(buttons, function (button) {
      if (button.dataset.tourBound === "1") return;
      button.dataset.tourBound = "1";
      button.addEventListener("click", start);
    });
  }

  function init() {
    bindReplayButtons();
    if (!storageGet()) {
      window.setTimeout(function () {
        if (!storageGet()) start();
      }, 450);
    }
  }

  window.OneSpendsTour = { start: start };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
