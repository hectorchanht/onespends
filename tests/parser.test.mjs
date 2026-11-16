// OneSpends parser tests — node, no deps. Run: node tests/parser.test.mjs
import assert from "node:assert";
import { parseReceiptText, parseCSV, parseJSON, parseHTML, filterNewRecords, dedupeKey, parseDateString, vendorFromDomain } from "../js/parser.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; }
}

// (a) zh-Hant receipt: 總計 + Chinese date + HK$
const zhReceipt = `
大家樂 Café de Coral
香港九龍觀塘道 123 號
電話: 2345 6789
日期: 2026-10-24
燒味雙拼飯        58.00
凍檸茶            12.00
小計             70.00
總計        HK$70.00
多謝惠顧
`;
test("zh-Hant receipt: amount from 總計 line", () => {
  const r = parseReceiptText(zhReceipt);
  assert.strictEqual(r.amount, 70);
});
test("zh-Hant receipt: date parsed", () => {
  const r = parseReceiptText(zhReceipt);
  assert.strictEqual(r.date, "2026-10-24");
});
test("zh-Hant receipt: currency HKD", () => {
  const r = parseReceiptText(zhReceipt);
  assert.strictEqual(r.currency, "HKD");
});
test("zh-Hant receipt: vendor is first shop line", () => {
  const r = parseReceiptText(zhReceipt);
  assert.ok(r.vendor && r.vendor.includes("大家樂"), `vendor=${r.vendor}`);
});

// zh receipt with 年月日 date + a bigger decoy number (points) — total must win
const zhReceipt2 = `
7-ELEVEN
2026年10月5日 14:32
會員積分 1250 點
即食麵 15.50
總額 15.50
`;
test("zh-Hant receipt 2: 年月日 date, total beats points decoy", () => {
  const r = parseReceiptText(zhReceipt2);
  assert.strictEqual(r.date, "2026-10-05");
  assert.strictEqual(r.amount, 15.5);
});

// (b) English receipt with TOTAL + DD/MM/YYYY
const enReceipt = `
STARBUCKS COFFEE
123 Queen Street
Tel: 416-555-0100
24/10/2026 09:15
Latte Grande          5.75
Blueberry Muffin      3.25
Subtotal              9.00
Tax                   1.17
TOTAL                $10.17
VISA ****1234
Thank you
`;
test("English receipt: TOTAL amount", () => {
  const r = parseReceiptText(enReceipt);
  assert.strictEqual(r.amount, 10.17);
});
test("English receipt: DD/MM/YYYY date", () => {
  const r = parseReceiptText(enReceipt);
  assert.strictEqual(r.date, "2026-10-24");
});
test("English receipt: vendor", () => {
  const r = parseReceiptText(enReceipt);
  assert.ok(r.vendor && r.vendor.toUpperCase().includes("STARBUCKS"), `vendor=${r.vendor}`);
});

// (b2) Benchmark hardenings — cases from the 2026-10-26 OCR benchmark
// (~/workspace/onespends-benchmark/, SROIE + zh synthetic subsets)

// Tesseract pads CJK date units with spaces — the date must still parse
const spacedDateReceipt = `
7-ELEVEN 便利 店
小 計 Subtotal 56.50
總 計 TOTAL HK$ 56.50
日 期 Date 2026 年 10 月 23 日 22:08
`;
test("benchmark: spaced CJK date (2026 年 10 月 23 日) parses", () => {
  const r = parseReceiptText(spacedDateReceipt);
  assert.strictEqual(r.date, "2026-10-23");
  assert.strictEqual(r.amount, 56.5);
});

// Malaysian receipts label the total TOT' — it must beat the subtotal line
const totReceipt = `
LIGHTROOM GALLERY SDN BHD
Bill Date : 20/11/2017
Sub Total : RM 263.02
GST/TAX 6% RM 15.78
TOT' RM 278.80
CASH RM 278.80
`;
test("benchmark: TOT' total label beats the subtotal", () => {
  const r = parseReceiptText(totReceipt);
  assert.strictEqual(r.amount, 278.8);
  assert.strictEqual(r.date, "2017-11-20");
});

// No total keyword anywhere: a 6-digit timestamp token must not win the
// largest-amount fallback over real decimal money
const trapReceipt = `
99 SPEED MART
03:29PM 562936 20-11-17
PEDIASURE COMPLETE RM117.90
MILO 2KG RM34.90
RM 169.80
`;
test("benchmark: fallback ignores 6-digit timestamp token", () => {
  const r = parseReceiptText(trapReceipt);
  assert.strictEqual(r.amount, 169.8);
});

// (b3) Real-receipt round 2 — cases from Hector's own receipts
// (~/workspace/onespends-benchmark/real-01/REPORT.md)

// North-American MM/DD/YYYY: month 13 is impossible, so 10/13 must be
// month-first (Goodwill). DD/MM assumption rejected this date entirely.
const goodwillReceipt = `
goodwill
Goodwill Outlet Store
2731 - 57 Ave SE Calgary
10/13/2026 4:49:44 PM
Weighted Item 7 @ $1.75ea  $12.25
TOTAL $12.25
Visa $12.25
`;
test("real-01: MM/DD/YYYY date parses (Goodwill 10/13/2026)", () => {
  const r = parseReceiptText(goodwillReceipt);
  assert.strictEqual(r.date, "2026-10-13");
  assert.strictEqual(r.amount, 12.25);
  assert.ok(r.vendor && r.vendor.toLowerCase().includes("goodwill"), `vendor=${r.vendor}`);
});

// Month-name dates, both orders (Goodwill card block + Kinjo)
test("real-01: month-name date, month first (Oct 13, 2026)", () => {
  const r = parseReceiptText(`Goodwill\nPurchase\nOct 13, 2026 16:49:58\nTotal $12.25\n`);
  assert.strictEqual(r.date, "2026-10-13");
});
test("real-01: month-name date, day first (25-Sep-2026)", () => {
  const r = parseReceiptText(`K4 Kinjo District\n25-Sep-2026 7:10:36 PM\nTotal CA$92.30\n`);
  assert.strictEqual(r.date, "2026-09-25");
});

// Both components ≤ 12 is genuinely ambiguous — the HK day-first default
// must be kept (05/10/2026 = 5 Oct, not May 10)
test("real-01: ambiguous 05/10/2026 stays DD/MM (HK default)", () => {
  const r = parseReceiptText(`STARBUCKS\n05/10/2026\nTOTAL $10.17\n`);
  assert.strictEqual(r.date, "2026-10-05");
});

// Year sanity: an OCR digit error (2026 -> 2626) is not a date (Shell)
test("real-01: insane year 2626 rejected, date is null not 2626", () => {
  const r = parseReceiptText(`SHELL CANADA\nAE 2626/08/29\nTOTAL SALE $63.98\n`);
  assert.strictEqual(r.date, null);
  assert.strictEqual(r.amount, 63.98);
});
test("real-01: insane year skipped, later sane date wins", () => {
  const r = parseReceiptText(`SHELL CANADA\nAE 2626/08/29\nDATE: 2026/08/29\nTOTAL SALE $63.98\n`);
  assert.strictEqual(r.date, "2026-08-29");
});

// Vendor: greeting line is furniture, the shop is the next line (Shell)
test("real-01: vendor skips WELCOME greeting line", () => {
  const r = parseReceiptText(`WELCOME\nshell Canada\n2020 16 AVENUE NE\nTOTAL SALE $63.98\n`);
  assert.strictEqual(r.vendor, "shell Canada");
});

// AMOUNT as total evidence + subtotal demotion (Costco, both engine texts)
const costcoTess = `
LoOSTcO
N Calgary #56
04 CAD SUBTOTAL 148.91
TAX 0.97
TOTAL ~ 142.00
ACCT: INTERAC FLASH DEFAULT
AMOUNT: $149.88
Interac 149.88
CHANGE 0.00
`;
test("real-01: payment AMOUNT beats subtotal + smudge-misread TOTAL (Costco)", () => {
  const r = parseReceiptText(costcoTess);
  assert.strictEqual(r.amount, 149.88);
});
const costcoPp = `
OSTCC
04 148.91
SLBTOTAL 0.97
TOTAL 14988
AMOUNT:$149.88
CUSTOMER COPY 149.88
`;
test("real-01: AMOUNT wins when TOTAL lost its decimal point (Costco PP)", () => {
  const r = parseReceiptText(costcoPp);
  assert.strictEqual(r.amount, 149.88);
});

// Tendered/change AMOUNT lines are not the charge — excluded from evidence
test("real-01: AMOUNT TENDERED does not override the TOTAL", () => {
  const r = parseReceiptText(`CORNER SHOP\nTOTAL $50.00\nAMOUNT TENDERED $100.00\nCHANGE $50.00\n`);
  assert.strictEqual(r.amount, 50);
});

// (b4) Currency from store location (round 3; owner's rule 2026-10-26).
// Strong location evidence beats the (garble-prone) symbol; an explicit
// symbol beats medium location evidence; no evidence stays null.

// Proof case (real-01 Shell): a £ hallucination on a Calgary receipt —
// the postal code + CANADA + GST pin CAD, location over symbol.
const shellGarbled = `
WELCOME
shell Canada
2020 16 AVENUE NE
T2E 1L8
Calgary AB
TOTAL SALE £63.98
GST Fuel 3.05
`;
test("real-01: strong location beats garbled £ symbol (Shell -> CAD)", () => {
  const r = parseReceiptText(shellGarbled);
  assert.strictEqual(r.currency, "CAD");
  assert.strictEqual(r.currencySource, "location");
});

// HK receipt with no currency symbol/code anywhere — location alone decides
const hkNoSymbol = `
大家樂 Café de Coral
香港九龍觀塘道 123 號
日期: 2026-10-24
燒味雙拼飯 58.00
總計 70.00
`;
test("round-3: HK receipt without symbol gets HKD from location", () => {
  const r = parseReceiptText(hkNoSymbol);
  assert.strictEqual(r.currency, "HKD");
  assert.strictEqual(r.currencySource, "location");
});

// Symbol present, no location evidence — the symbol is kept as-is
test("round-3: symbol kept when no location evidence", () => {
  const r = parseReceiptText(`CORNER SHOP\nTOTAL HK$50.00\n`);
  assert.strictEqual(r.currency, "HKD");
  assert.strictEqual(r.currencySource, "symbol");
});

// Medium evidence (city table) does NOT override an explicit symbol
test("round-3: explicit symbol beats medium (city) evidence", () => {
  const r = parseReceiptText(`STARBUCKS\nCalgary\nTOTAL £10.17\n`);
  assert.strictEqual(r.currency, "GBP");
  assert.strictEqual(r.currencySource, "symbol");
});

// No symbol, no location evidence — currency stays null, never a guess
test("round-3: no evidence stays null", () => {
  const r = parseReceiptText(`MYSTERY SHOP\nTOTAL 42.00\n`);
  assert.strictEqual(r.currency, null);
  assert.strictEqual(r.currencySource, null);
});

// US address tail (City, ST ZIP) with no symbol — medium evidence -> USD
test("round-3: US ZIP + state gives USD when no symbol", () => {
  const r = parseReceiptText(`DINER\n123 Main St, Denver, CO 80202\nTOTAL 25.00\n`);
  assert.strictEqual(r.currency, "USD");
  assert.strictEqual(r.currencySource, "location");
});

// (b5) Real-receipt round 4 — cancelled slips, vendor furniture + fuzzy,
// decoy digits, zero totals, glued keywords
// (~/workspace/onespends-benchmark/real-01..03 reports)

// Cancelled Shell slip (real-03 receipt-4): PP splits the stamp across
// two lines ("TRANSACTION" / "CANCELLED") and misreads TOTAL SALE $0.00
// as 10.00 — the parser must flag it and suppress the amount entirely.
const cancelledShell = `
WELCOME
Shell Canada
2020 16 AVENUE NE 2026
T2E 1L3
TOTAL SALE 10.00
visa XXXXXXXXXXXX2404
AMT: $0.00
DATE: 2026/08/29
01 APPROVED THANK YOU 027
TRANSACTION
CANCELLED
INVOICE NUMBER 9909719
`;
test("real-03: cancelled slip flagged, amount suppressed (split stamp)", () => {
  const r = parseReceiptText(cancelledShell);
  assert.strictEqual(r.cancelled, true);
  assert.strictEqual(r.amount, null);
  assert.strictEqual(r.totalFound, false);
  assert.strictEqual(r.date, "2026-08-29");
  assert.strictEqual(r.vendor, "Shell Canada");
});
test("real-03: one-line TRANSACTION CANCELLED also suppresses the amount", () => {
  const r = parseReceiptText(`CORNER SHOP\nTRANSACTION CANCELLED\nTOTAL $50.00\n`);
  assert.strictEqual(r.cancelled, true);
  assert.strictEqual(r.amount, null);
});
test("real-03: CJK cancellation stamp （交易取消） suppresses the amount", () => {
  const r = parseReceiptText(`茶餐廳\n交易取消\n總計 $50.00\n`);
  assert.strictEqual(r.cancelled, true);
  assert.strictEqual(r.amount, null);
});
test("real-03: cancellation POLICY prose does not flag the receipt", () => {
  const r = parseReceiptText(`HOTEL\nCancellation policy: free cancellation until 6pm\nTOTAL $120.00\n`);
  assert.strictEqual(r.cancelled, false);
  assert.strictEqual(r.amount, 120);
});
test("real-03: VOID WHERE PROHIBITED does not flag the receipt", () => {
  const r = parseReceiptText(`SHOP\nVOID WHERE PROHIBITED\nTOTAL $25.00\n`);
  assert.strictEqual(r.cancelled, false);
  assert.strictEqual(r.amount, 25);
});

// Slip-header furniture is not a shop name (Partsource / Spyhill slips)
test("real-02: TRANSACTION RECORD header skipped, fuzzy vendor wins", () => {
  const r = parseReceiptText(`TRANSACTION RECORD\nRTSOURCE CALGARY - PS795\nPURCHASE\nVISA\n$31.48\nNUMBER: ************2404\n`);
  assert.strictEqual(r.vendor, "Partsource");
});
// QR review caption above the shop name (Dank Cannabis), incl. the
// observed misread REVIEN for REVIEW
test("real-03: LEAVE A REVIEW caption skipped", () => {
  const r = parseReceiptText(`LEAVE A REVIEW\nDank Cannabis\nTotal $25.19\n`);
  assert.strictEqual(r.vendor, "Dank Cannabis");
});
test("real-03: LEAVE A REVIEN (misread caption) skipped", () => {
  const r = parseReceiptText(`LEAVE A REVIEN\nDank Cannabis\nTotal $25.19\n`);
  assert.strictEqual(r.vendor, "Dank Cannabis");
});

// Fuzzy vendor: stylised-logo garbles of chain names canonicalise
test("real-02: goadwill -> Goodwill", () => {
  const r = parseReceiptText(`goadwill\nOutlet Store\nTOTAL $33.25\n`);
  assert.strictEqual(r.vendor, "Goodwill");
});
test("real-02: goaduill -> Goodwill", () => {
  const r = parseReceiptText(`goaduill\nTOTAL $8.75\n`);
  assert.strictEqual(r.vendor, "Goodwill");
});
test("round-4: non-chain vendor line is left untouched by fuzzy", () => {
  const r = parseReceiptText(`UNCLE TETSUS CHEESECAKE\nTOTAL $12.00\n`);
  assert.ok(r.vendor && r.vendor.includes("UNCLE"), `vendor=${r.vendor}`);
});

// Decoy digits in the fallback: card last-4 must not beat the real amount
test("real-02: card last-4 decoy loses to the clean amount (Partsource)", () => {
  const r = parseReceiptText(`TRANSACTION RECORD\nRTSOURCE CALGARY - PS795\nPURCHASE\nVISA\n$31.48\nNUMBER: ************2404\n`);
  assert.strictEqual(r.amount, 31.48);
});
// Phone-number digits must not become the amount (Canadian Tire 9550)
test("real-02: phone number is not the amount", () => {
  const r = parseReceiptText(`CANADIAN TIRE STORE\n(403) 226-9550\nWIDGET 0.99\nGADGET 12.50\n`);
  assert.strictEqual(r.amount, 12.5);
});
// Word-glued GST rate chunk ("GST5000V") is a code fragment, not money
test("real-02: GST5000V chunk is not the amount", () => {
  const r = parseReceiptText(`DANK SHOP\nITEM A 30.98\nGST5000V 300\n`);
  assert.strictEqual(r.amount, 30.98);
});

// Zero total is a total (Visions net-zero exchange)
test("real-02: explicit TOTAL 0.00 is found, amount 0", () => {
  const r = parseReceiptText(`VISIONS ELECTRONICS\nITEM RETURN -268.00\nITEM 268.00\nSubtotal: 0.00\nGST: Total: 0.00\n`);
  assert.strictEqual(r.amount, 0);
  assert.strictEqual(r.totalFound, true);
});
test("real-02: TOTAL SAVINGS 0.00 does not zero out a real total", () => {
  const r = parseReceiptText(`SHOP\nTOTAL SAVINGS $0.00\nTOTAL $25.40\n`);
  assert.strictEqual(r.amount, 25.4);
});
test("round-4: totalFound distinguishes evidence hits from fallback", () => {
  assert.strictEqual(parseReceiptText(`SHOP\nTOTAL $10.00\n`).totalFound, true);
  const fb = parseReceiptText(`SHOP\nITEM 42.00\n`);
  assert.strictEqual(fb.amount, 42);
  assert.strictEqual(fb.totalFound, false);
});

// Glued keyword: JBTOTAL is not a total label — the tax must not win
test("real-02: JBTOTAL glued keyword does not claim the tax (Costco #543)", () => {
  const r = parseReceiptText(`COSTCO WHOLESALE\nITEM A 50.00\nJBTOTAL 1.67\nCUSTOMER COPY 114.78\n`);
  assert.strictEqual(r.amount, 114.78);
});

// (c) CSV with headers (Chinese headers) + dedupe
const csv = `日期,商戶,金額,幣別,分類
2026-10-24,大家樂,70.00,HKD,餐飲
2026-10-23,港鐵,12.50,HKD,交通
24/10/2026,Amazon,29.99,USD,購物
`;
test("CSV with zh headers parses 3 rows", () => {
  const rows = parseCSV(csv);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].vendor, "大家樂");
  assert.strictEqual(rows[0].amount, 70);
  assert.strictEqual(rows[0].category, "餐飲");
  assert.strictEqual(rows[2].date, "2026-10-24");
  assert.strictEqual(rows[2].currency, "USD");
});

// no-header CSV position fallback
const csvNoHead = `2026-10-20,OK便利店,25.00,HKD
2026-10-21,的士,89.00,HKD
`;
test("CSV no-header position fallback", () => {
  const rows = parseCSV(csvNoHead);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].vendor, "的士");
  assert.strictEqual(rows[1].amount, 89);
});

test("dedupe: same date+amount+vendor skipped", () => {
  const existing = [{ date: "2026-10-24", amount: 70, vendor: "大家樂", currency: "HKD", category: "餐飲" }];
  const incoming = parseCSV(csv);
  const { toAdd, skipped } = filterNewRecords(existing, incoming);
  assert.strictEqual(skipped, 1);
  assert.strictEqual(toAdd.length, 2);
  assert.strictEqual(dedupeKey(existing[0]), dedupeKey(incoming[0]));
});

test("dedupe: duplicates within the incoming file itself", () => {
  const dup = parseCSV(`2026-10-24,大家樂,70.00,HKD\n2026-10-24,大家樂,70.00,HKD\n`);
  const { toAdd, skipped } = filterNewRecords([], dup);
  assert.strictEqual(toAdd.length, 1);
  assert.strictEqual(skipped, 1);
});

// (d) JSON: bare array with mixed bilingual keys; rows without date/amount skipped
const jsonArray = JSON.stringify([
  { "注文日": "2026-10-20", "商品名": "ワンピース フィギュア", "落札価格": "12,800", "通貨": "円" },
  { date: "2026-10-21", title: "Game cartridge", amount: 5400, currency: "JPY" },
  { title: "冇日期冇金額", note: "should be skipped" },
]);
test("JSON array: mixed ja/en keys parse, bad row skipped", () => {
  const rows = parseJSON(jsonArray);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].date, "2026-10-20");
  assert.strictEqual(rows[0].amount, 12800);
  assert.strictEqual(rows[0].vendor, "ワンピース フィギュア");
  assert.strictEqual(rows[0].currency, "JPY");
  assert.strictEqual(rows[0].category, "購物");
  assert.strictEqual(rows[1].date, "2026-10-21");
  assert.strictEqual(rows[1].amount, 5400);
  assert.strictEqual(rows[1].vendor, "Game cartridge");
  assert.strictEqual(rows[1].currency, "JPY");
});

// (e) JSON: nested { orders: [...] } with camelCase keys + ¥ inside the price
const jsonNested = JSON.stringify({
  orders: [
    { orderDate: "2026/10/22", item: "漫画 全巻セット", price: "¥3,200" },
    { order_date: "2026-10-23", name: "レコード LP", total: 6800, currency: "JPY" },
  ],
});
test("JSON nested {orders:[...]}: camelCase/snake keys + ¥ in price", () => {
  const rows = parseJSON(jsonNested);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].date, "2026-10-22");
  assert.strictEqual(rows[0].amount, 3200);
  assert.strictEqual(rows[0].currency, "JPY");
  assert.strictEqual(rows[0].vendor, "漫画 全巻セット");
  assert.strictEqual(rows[1].date, "2026-10-23");
  assert.strictEqual(rows[1].amount, 6800);
});

// (f) HTML: saved Jauce-style won-items table （日付/商品名/落札価格）
const jauceHTML = `<!DOCTYPE html><html><head><title>My Account - Won Items</title></head><body>
<h1>落札済み商品</h1>
<table border="1">
  <tr><th>日付</th><th>商品名</th><th>落札価格</th></tr>
  <tr><td>2026/10/15</td><td>レトロ腕時計 セイコー</td><td>25,000円</td></tr>
  <tr><td>2026/10/16</td><td>カメラレンズ 50mm</td><td>48,500円</td></tr>
  <tr><td>合計</td><td></td><td>73,500円</td></tr>
</table>
</body></html>`;
test("HTML table: Jauce-style won items parse (header + rows, total row skipped)", () => {
  const rows = parseHTML(jauceHTML);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].date, "2026-10-15");
  assert.strictEqual(rows[0].amount, 25000);
  assert.strictEqual(rows[0].vendor, "レトロ腕時計 セイコー");
  assert.strictEqual(rows[0].currency, "JPY");
  assert.strictEqual(rows[0].category, "購物");
  assert.strictEqual(rows[1].date, "2026-10-16");
  assert.strictEqual(rows[1].amount, 48500);
});

test("HTML imports: dedupe against existing records still applies", () => {
  const existing = [{ date: "2026-10-15", amount: 25000, vendor: "レトロ腕時計 セイコー", currency: "JPY", category: "購物" }];
  const incoming = parseHTML(jauceHTML);
  const { toAdd, skipped } = filterNewRecords(existing, incoming);
  assert.strictEqual(skipped, 1);
  assert.strictEqual(toAdd.length, 1);
  assert.strictEqual(toAdd[0].vendor, "カメラレンズ 50mm");
});

// (g) HTML fallback: no table — date and amount paired from plain lines
const plainHTML = `<html><body>
<div class="order">
  <p>注文日：2026年10月18日</p>
  <p>商品：中古ゲームソフト</p>
  <p>お支払い金額：9,800円</p>
</div>
</body></html>`;
test("HTML fallback: line-scan pairs date with nearby amount", () => {
  const rows = parseHTML(plainHTML);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].date, "2026-10-18");
  assert.strictEqual(rows[0].amount, 9800);
  assert.strictEqual(rows[0].currency, "JPY");
});

// (b6) Real-receipt round 5 — Hector's first phone scan (PartSource,
// 2026-10-26): vendor from the printed domain, full date-format matrix,
// category suggestion defaults to null
// (~/workspace/onespends-benchmark/real-02 receipt-14 is the same slip)

// The itemised receipt from his photo, with the logo line replaced by
// the garble his phone actually produced ("店 oo ="). The shop's domain
// is printed at the foot: AT WWW.PARTSOURCE.CA.
const partsourcePhone = `
店 oo =
STORE # 795
637 GODDARD AVE. N.E.
CALGARY, AB T2K 6K1
GST #GST# R100773019
(403)274-5901
RECEIPT# 1315777
2026-10-08 05:17 PM
1157ALL.BP2 LAMP BUL 9.99
H301 REAR WIPER BLAD 19.99
SUB-TOTAL 29.98
GST TAX 1.50
TOTAL 31.48
VISA 31.48
SEE OUR RETAIL RETURN POLICY
AT WWW.PARTSOURCE.CA
`;
test("real-02/phone: logo garble rejected, vendor from domain (Partsource)", () => {
  const r = parseReceiptText(partsourcePhone);
  assert.strictEqual(r.vendor, "Partsource");
  assert.strictEqual(r.amount, 31.48);
  assert.strictEqual(r.currency, "CAD");
});
test("real-02/phone: YYYY-MM-DD + 12h time date (2026-10-08 05:17 PM)", () => {
  const r = parseReceiptText(partsourcePhone);
  assert.strictEqual(r.date, "2026-10-08");
});
test("real-02/phone: auto parts stay uncategorised (category null)", () => {
  const r = parseReceiptText(partsourcePhone);
  assert.strictEqual(r.category, null);
});

// The saved PP-OCR card-slip text for the same receipt (real-02
// receipt-14): no domain on a card slip, but the glued timestamp
// "080ct2026" (Oct with a zero for the O) must now parse.
const partsourceSlipPP = `
TRANSACTION RECORD
RTSOURCE CALGARY - PS795
GODDARD AVE.N.E.
ARY, AB T2K 6K1
PURCHASE
VISA
$31.48
UMBER: ************2404
IME: 080ct202617:17:13
`;
test("real-02: saved PP slip text — vendor + glued 0ct date", () => {
  const r = parseReceiptText(partsourceSlipPP);
  assert.strictEqual(r.vendor, "Partsource");
  assert.strictEqual(r.amount, 31.48);
  assert.strictEqual(r.date, "2026-10-08");
});

// Vendor precedence: a sane top-line name beats the domain
test("round-5: sane line-pick beats the printed domain", () => {
  const r = parseReceiptText(`UNCLE TETSUS CHEESECAKE\nTOTAL $12.00\nwww.uncletetsu.com\n`);
  assert.strictEqual(r.vendor, "UNCLE TETSUS CHEESECAKE");
});
// Garbage line-pick with no domain anywhere: null, never the garble
test("round-5: garbage line-pick without domain is null", () => {
  const r = parseReceiptText(`店 oo =\nTOTAL $12.00\n`);
  assert.strictEqual(r.vendor, null);
});
// Symbol-polluted name fragment: the buried letter run is salvaged
test("round-5: ===WHOLESALE salvages the name fragment", () => {
  const r = parseReceiptText(`===WHOLESALE\nTOTAL $114.78\n`);
  assert.strictEqual(r.vendor, "WHOLESALE");
});
// Domain extraction tolerances
test("round-5: domain with OCR spacing around the dots", () => {
  assert.strictEqual(vendorFromDomain(`AT www . partsource . ca`), "Partsource");
});
test("round-5: hyphenated domain stem becomes Title-case words", () => {
  assert.strictEqual(vendorFromDomain(`店 oo =\nwww.uncle-tetsu.com`), "Uncle Tetsu");
});
test("round-5: non-chain domain stem is Title-cased as-is", () => {
  assert.strictEqual(vendorFromDomain(`店 oo =\nmountainmart.ca`), "Mountainmart");
});
test("round-5: payment-platform domain (clover.com) is not the vendor", () => {
  const r = parseReceiptText(`@@@ ###\nTOTAL $20.00\npaid via clover.com\n`);
  assert.strictEqual(r.vendor, null);
});

// Date-format matrix — one test per format
test("round-5 date: YYYY.MM.DD dotted", () => {
  assert.strictEqual(parseDateString("2026.10.08"), "2026-10-08");
});
test("round-5 date: YYYY-MM-DD with HH:MM:SS", () => {
  assert.strictEqual(parseDateString("2026-10-08 17:17:13"), "2026-10-08");
});
test("round-5 date: YYYY-MM-DD with 12h AM/PM", () => {
  assert.strictEqual(parseDateString("2026-10-08 05:17 PM"), "2026-10-08");
});
test("round-5 date: MM/DD/YYYY with 12h AM/PM", () => {
  assert.strictEqual(parseDateString("10/13/2026 05:17 PM"), "2026-10-13");
});
test("round-5 date: DD-MM-YYYY dashed", () => {
  assert.strictEqual(parseDateString("08-10-2026"), "2026-10-08");
});
test("round-5 date: month-name with time (Oct 8, 2026 5:17 PM)", () => {
  assert.strictEqual(parseDateString("Oct 8, 2026 5:17 PM"), "2026-10-08");
});
test("round-5 date: compact YYYYMMDD", () => {
  assert.strictEqual(parseDateString("20261008"), "2026-10-08");
});
test("round-5 date: compact invalid dates stay null", () => {
  assert.strictEqual(parseDateString("20260230"), null);
  assert.strictEqual(parseDateString("20261308"), null);
});
test("round-5 date: 2-digit year windows into the sanity range (10/08/26)", () => {
  // both components ≤ 12 → the documented DD/MM default applies
  assert.strictEqual(parseDateString("10/08/26"), "2026-08-10");
});
test("round-5 date: dotted single-digit D.M.YYYY", () => {
  assert.strictEqual(parseDateString("8.10.2026"), "2026-10-08");
});
test("round-5 date: CJK 年月日 with 時 time", () => {
  assert.strictEqual(parseDateString("2026年10月8日 17時17分"), "2026-10-08");
});
test("round-5 date: glued OCR zero-Oct (080ct2026)", () => {
  assert.strictEqual(parseDateString("080ct2026"), "2026-10-08");
});

// Category suggestion: high-confidence evidence only, else null
test("round-5 category: Starbucks (chain) -> 餐飲", () => {
  assert.strictEqual(parseReceiptText(enReceipt).category, "餐飲");
});
test("round-5 category: Shell (chain) -> 交通", () => {
  assert.strictEqual(parseReceiptText(shellGarbled).category, "交通");
});
test("round-5 category: café in the vendor name -> 餐飲", () => {
  assert.strictEqual(parseReceiptText(zhReceipt).category, "餐飲");
});
test("round-5 category: fuel goods line -> 交通", () => {
  const r = parseReceiptText(`PETRO GAS BAR\nUNLEADED GASOLINE 40.00\nTOTAL $40.00\n`);
  assert.strictEqual(r.category, "交通");
});
test("round-5 category: warehouse / thrift stay null", () => {
  assert.strictEqual(parseReceiptText(costcoTess).category, null);
  assert.strictEqual(parseReceiptText(goodwillReceipt).category, null);
});

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures)" : ""}`);
