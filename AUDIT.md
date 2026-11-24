# OneSpends Icon Sweep — AUDIT (2026-11-23, Wave 2)

Repo: hectorchanht/onespends @ main, head 6f0ae4c2dc2ce47087f78667b4ede9f93df18f22
Law: Dawn-Design.md §8 v1.6 — every UI label an icon can carry must be an icon;
accessible name kept (aria-label/title). Quantities stay numeric; content is not a label.
NO STRETCH: fixed geometry, fixed icon size.
Live: https://onespends.dawnstudio.app (README + canonical links)
Icon system: the app's own unicode/emoji glyph set used inline throughout
(＋ ⬆ ⬇ 📷 ⚙ 👤 ✕ ‹ ›) — icons/ dir holds only the PWA app icons (png).
All conversions reuse that existing glyph set; no new icon system introduced.

## Already icon-only (verified, no change)
- Header action dock: add (＋), import (⬆), export CSV (⬇), scan receipt (📷) — icon-only round buttons, aria-label + title on each.
- Month picker prev/next (‹ ›), dialog close buttons (✕), OCR progress glyph.
- Spend rows: category glyph + vendor/amount content, aria-label carries 編輯 + vendor + amount.

## Converted (visible text label → icon only, aria-label/title = former label)
app.html:
1. Header tour button: ？ + visible span 導覽 (shown ≥wide breakpoint) → ？ only; aria-label/title kept.
2. Header account button: 👤 + visible span 登入 / signed-in username → 👤 only; JS now moves the state into aria-label/title (帳戶 · 登入 / 帳戶 · <email>); the signed-in amber border (is-in) already encodes state.
3. Header settings button: ⚙ + visible span 設定 → ⚙ only; aria-label/title kept.
4. Spend form actions: 儲存 → ✓ (JS sets aria-label 儲存/更新 per add/edit mode); 取消 → ✕; 刪除 (🗑+text) → 🗑 only. All keep aria-label + title.
5. Account dialog: 立即同步 → 🔄 only; 登出 → 🚪 only. aria-label + title carry the words.
6. Import dialog file pick: 揀檔案 text label → ⬆ only, aria-label="揀檔案".

js/app.js:
7. Empty-state glance-card actions （影收據 📷 / 加一筆 ＋ / 匯入檔案 ⬆, icon+text) → icon-only, aria-label + title added; .gc-btn geometry fixed at 48×44 (NO STRETCH).
8. Recent panel "全部 N / 收起" toggle → ▾ + count (count is a quantity, stays) / ▴; aria-label carries 顯示全部/收起.

app.css:
9. Removed the now-dead .tour-btn-label rules (base + wide-breakpoint) — stale code retired in the same change (GOLD rule).

## Kept as text — with reason
- Month pill label （本月 / 2026年11月…): the selected-month VALUE, not a control label.
- Stats range chips （本月/上月/近 7 日/近 30 日/近 3 個月/今年/自訂） + currency chips (code · N 筆）: range-preset / currency VALUES (MoneyRate wave-1 precedent: chart range presets stay).
- Month-picker 今月 / 完成 buttons: preset value + dialog Done (HuntSteals wave-1 precedent: "Done" kept).
- Account CTAs 寄登入連結俾我 / 用驗證碼登入： primary CTA sentences no single glyph carries (HuntSteals precedent: "Email me a sign-in link" kept).
- PP-OCR retry button: sentence label carrying the ~34 MB download size (data); explanatory hint sits directly under it.
- Empty-list ＋ 加第一筆 inline CTA: primary CTA words are the offer (HuntSteals precedent), glyph already present.
- Dialog headings （＋ 加一筆 / ⬆ 匯入 / 👤 帳戶 / ⚙ 設定）, panel headings （分類/最近 7 日/統計/趨勢…), form field labels （商戶/金額/貨幣/日期/分類/備註）, settings option rows: headings / field descriptions / content, not labels on a separate control.
- Landing + guides/tour/value pages: nav links are distinct destination names (content, DawnStudio wave-1 precedent); 開 App CTAs kept (HuntSteals precedent: "Open the app" kept); feature-card glyphs already icons.
- Amounts, totals, dates, percentages, DEMO/示範數據 badges: quantities / status content.
