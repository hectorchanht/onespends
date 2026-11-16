// OneSpends — deterministic local parsers (receipt OCR text + CSV + JSON + HTML).
// Pure functions, no DOM — unit-testable in node.

export const CURRENCIES = ["HKD", "USD", "CAD", "TWD", "CNY", "JPY", "GBP", "EUR"];

export const CATEGORIES = ["餐飲", "交通", "購物", "娛樂", "家居", "醫療", "訂閱", "旅行", "其他"];

const TOTAL_KEYWORDS_CJK = ["總計", "總額", "合計", "總數", "應付", "實付", "應收"];
const TOTAL_KEYWORDS_LATIN = [
  "total", "grand total", "amount due", "balance due", "amount payable",
];
// Latin total keywords must match at a letter boundary (round 4): a TOTAL
// glued onto other letters is not a total label — real-02 Costco #543,
// where PP-OCR row clustering merged the tax row into "JBTOTAL 1.67" and
// the old substring match handed the parser the tax as the total. CJK
// keywords have no letter-boundary concept and keep substring matching.
const TOTAL_LATIN_RES = TOTAL_KEYWORDS_LATIN.map(
  (k) => new RegExp(`(?<![a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`));

// Malaysian receipts abbreviate the total label as TOT' / TOT" / bare TOT.
// Boundary-safe: the letter lookahead keeps it from firing inside TOTAL
// (already a keyword above), TOTALS or TOTE.
const TOTAL_ABBR_RE = /\btot['"]?(?![a-z])/i;

// Payment-block AMOUNT ("AMOUNT: $149.88", "Amount $12.25") is the charged
// total on card receipts — total evidence, ranked with the TOTAL family and
// above the subtotal/fallback pools (real-01 Costco: both engines' texts
// held the right total only on the AMOUNT line). Tendered / change amounts
// are what the customer handed over / got back, not the charge — excluded.
// "Amount due" needs no rule here: it is already a TOTAL keyword above.
const AMOUNT_PAID_RE = /\bamount\b/i;
const AMOUNT_NOT_PAID_RE = /\b(tendered|change)\b/i;

// money token: optional currency marker + number (with commas / decimals)
const MONEY_RE = /(HK\$|US\$|NT\$|CA\$|\$|¥|円|£|€|RMB|HKD|USD|TWD|JPY|GBP|EUR|CNY)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2}|\d{1,7})/g;

function moneyTokens(line) {
  const out = [];
  let m;
  MONEY_RE.lastIndex = 0;
  while ((m = MONEY_RE.exec(line)) !== null) {
    const raw = m[2];
    const value = parseFloat(raw.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const hasDecimal = raw.includes(".");
    const hasMarker = !!m[1];
    // Position of the digits inside the line (round 4): a bare integer
    // glued straight onto a word ("GST5000V", "PS795") is a code fragment,
    // not money, and a number immediately followed by "%" is a rate.
    const numStart = m.index + m[0].indexOf(raw);
    const glued = numStart > 0 && /[A-Za-z]/.test(line[numStart - 1]);
    const pct = line[numStart + raw.length] === "%";
    out.push({ value, hasDecimal, hasMarker, raw, glued, pct });
  }
  return out;
}

function isPlausibleTotal(tok, line) {
  if (tok.value <= 0 || tok.value >= 1000000) return false;
  // a bare 4-digit year alone on a line is not money
  if (!tok.hasDecimal && !tok.hasMarker && /^(19|20)\d{2}$/.test(tok.raw)) return false;
  // long digit runs are phone / card / receipt numbers
  if (!tok.hasDecimal && tok.raw.replace(/,/g, "").length > 6) return false;
  return true;
}

// Plausible receipt-year window. A "date" whose year falls outside it is
// an OCR digit error (real-01: Shell's 2026 read as "2626"), not a date —
// reject it and let the caller keep looking at other candidates.
const YEAR_MIN = 2010;
function yearSane(y) {
  return y >= YEAR_MIN && y <= new Date().getFullYear() + 1;
}

const MONTH_NUMBERS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
  // OCR reads the capital O of Oct as a zero (round 5, real-02
  // Partsource PP text: "080ct2026" for 08-Oct-2026) — accept the
  // zero-initial spellings as October aliases.
  "0ctober": 10, "0ct": 10,
};
const MONTH_NAME_SRC =
  "january|february|march|april|may|june|july|august|september|october|november|december" +
  "|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|0ctober|0ct";
// North-American month-name dates (real-01): "Oct 13, 2026", "13 Oct 2026",
// "25-Sep-2026". Separators are optional — OCR glues the fields together
// ("25-Sep-20267:10:36P", "25Sep2026").
const MONTH_FIRST_RE = new RegExp(
  `(${MONTH_NAME_SRC})\\.?[-\\s]?(\\d{1,2})(?:st|nd|rd|th)?[,\\s-]+(\\d{4})`, "gi");
const DAY_FIRST_RE = new RegExp(
  `(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?[-\\s]?(${MONTH_NAME_SRC})\\.?[-\\s]?(\\d{4})`, "gi");

// Ambiguous numeric date in printed order (a, b, year): a > 12 can only be
// the day (DD/MM); b > 12 can only be the day, so a is the month (MM/DD —
// North-American receipts print this way, real-01 Goodwill "10/13/2026").
// Both ≤ 12 is genuinely ambiguous: keep the HK/TW day-first default this
// parser was built for, so HK receipts parse exactly as before.
function numericDate(y, a, b) {
  if (a > 12 && b > 12) return null;
  if (b > 12) return toISO(y, a, b); // MM/DD
  return toISO(y, b, a); // DD/MM — including the both-≤12 default
}

export function parseDateString(s) {
  if (!s) return null;
  s = String(s).trim();
  // Every pattern iterates ALL of its matches: a candidate that fails
  // validation (impossible month/day, insane year) is skipped, not fatal —
  // the parser keeps looking, here and in the caller's next line.
  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / YYYY年M月D日 — OCR may pad the
  // CJK units (and the separators) with spaces: "2026 年 10 月 23 日".
  // Any trailing time ("2026-10-08 05:17 PM") simply isn't part of the
  // match, so datetime forms are covered by the same pattern.
  for (const m of s.matchAll(/(?<!\d)(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/g)) {
    const d = toISO(+m[1], +m[2], +m[3]);
    if (d) return d;
  }
  // month-name dates (EN, full or 3-letter abbreviations)
  for (const m of s.matchAll(MONTH_FIRST_RE)) {
    const d = toISO(+m[3], MONTH_NUMBERS[m[1].toLowerCase()], +m[2]);
    if (d) return d;
  }
  for (const m of s.matchAll(DAY_FIRST_RE)) {
    const d = toISO(+m[3], MONTH_NUMBERS[m[2].toLowerCase()], +m[1]);
    if (d) return d;
  }
  // numeric, 4-digit year (DD/MM or MM/DD — see numericDate); the
  // dotted form "08.10.2026" is the same shape with a dot separator
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/g)) {
    const d = numericDate(+m[3], +m[1], +m[2]);
    if (d) return d;
  }
  // numeric, 2-digit year — same disambiguation; the 20xx window plus
  // the year-sanity range in toISO keeps "10/08/26" at 2026
  for (const m of s.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})(?!\d)/g)) {
    const d = numericDate(2000 + +m[3], +m[1], +m[2]);
    if (d) return d;
  }
  // compact YYYYMMDD — card slips glue the fields together with the
  // time ("20261008", "080ct2026" is the month-name case above). The
  // lookarounds keep digit runs inside longer serials out; toISO still
  // validates the calendar date and the year window.
  for (const m of s.matchAll(/(?<!\d)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/g)) {
    const d = toISO(+m[1], +m[2], +m[3]);
    if (d) return d;
  }
  // Chinese without year marker on first part: M月D日 — no year, skip
  return null;
}

function toISO(y, mo, d) {
  if (!yearSane(y)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}`;
}

function findDate(text) {
  // scan line by line; prefer a line that looks like a date line
  for (const line of text.split(/\r?\n/)) {
    const d = parseDateString(line);
    if (d) return d;
  }
  return parseDateString(text);
}

function findCurrency(text) {
  const t = text;
  if (/HK\$|HKD|港幣|港元/.test(t)) return "HKD";
  if (/NT\$|TWD|新台幣|台幣/.test(t)) return "TWD";
  if (/US\$|USD|美金|美元/.test(t)) return "USD";
  if (/CA\$|CAD|加幣|加元/.test(t)) return "CAD";
  if (/人民幣|RMB|CNY/.test(t)) return "CNY";
  if (/円|¥|JPY|日圓|日元/.test(t)) return "JPY";
  if (/£|GBP|英鎊/.test(t)) return "GBP";
  if (/€|EUR|歐元/.test(t)) return "EUR";
  return null;
}

// --- currency from store location (round 3; owner's rule 2026-10-26: "the
// currency can be determined by the location of the store"). A currency
// symbol/code is 1-2 glyphs and OCR garbles it easily — real-01: Tesseract
// hallucinated £ on the Calgary Shell receipt, and stray ¥/円 readings put
// JPY on two more Calgary receipts. Address text is long and redundant
// (postal code + city + tax labels all repeat the same fact), so STRONG
// location evidence outranks the symbol; MEDIUM evidence only fills in
// when no symbol was read at all. No evidence → null, never a guess.
// First match wins within a tier; most specific signals are listed first.
const LOC_STRONG_RES = [
  // Canada — postal code (A1A 1A1 shape), sales-tax labels, country name.
  [/\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/, "CAD"],
  // (The trailing guard is "not a letter", not \b: OCR glues the rate
  // onto the label — real-02 read "GST 5.000%" as "GST5000V" — while a
  // following letter would mean a longer word/code, not the tax label.)
  [/\b(?:GST|HST|PST|QST)(?![A-Za-z])/, "CAD"],
  [/\bCANADA\b/i, "CAD"],
  // Taiwan — the 統一編號 field is printed on every TW receipt/invoice.
  [/統一編號/, "TWD"],
  [/臺灣|台灣/, "TWD"],
  // Japan — postal mark 〒, kana script (never appears on HK/TW receipts),
  // address components, country name.
  [/〒/, "JPY"],
  [/[ぁ-んァ-ヶ]/, "JPY"],
  [/丁目|番地/, "JPY"],
  [/日本/, "JPY"],
  // Hong Kong — characters / English name, district names, and a labelled
  // 8-digit phone (HK numbers start 2/3/5/6/9; the digit guards keep
  // 10-digit NANP numbers from matching).
  [/香港/, "HKD"],
  [/\bHong\s*Kong\b/i, "HKD"],
  [/觀塘|九龍|中環|銅鑼灣|旺角|尖沙咀|沙田|荃灣|元朗|屯門|上環|灣仔|深水埗|將軍澳/, "HKD"],
  [/\b(?:Kwun Tong|Kowloon|Causeway Bay|Mong Kok|Tsim Sha Tsui|Sha Tin|Tsuen Wan|Yuen Long|Tuen Mun|Sheung Wan|Wan Chai)\b/i, "HKD"],
  [/(?:電話|tel|phone)[:：]?\s*(?<!\d)[23569]\d{3}[\s-]?\d{4}(?!\d)/i, "HKD"],
  // UK — postcode: outward letters+digit(s), inward digit + two letters.
  // A Canadian code cannot match (its inward part ends letter-digit).
  // The space between the halves is REQUIRED: the spaceless shape also
  // fits random letter/digit garbage tokens OCR produces (real-02:
  // "re09rd", "s10oo" on Calgary receipts) — real UK postcodes print
  // spaced, so precision wins over the rare spaceless printing.
  [/\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s+\d[A-Za-z]{2}\b/, "GBP"],
  // United States — country name (the address tail is only medium).
  [/\b(?:U\.?S\.?A\.?|United States(?: of America)?)\b/i, "USD"],
];
const LOC_MEDIUM_RES = [
  // US address tail "City, ST 12345(-1234)": state abbreviation directly
  // before a ZIP. (A Canadian tail puts the postal code there instead —
  // already claimed by the strong tier.)
  [/,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/, "USD"],
  // ", PROV" on an address line — Canadian province abbreviations.
  [/,\s*(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b/, "CAD"],
  // ", ST" — US state abbreviations.
  [/,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/, "USD"],
  // City table — kept small on purpose, covered locales only.
  [/\b(?:Calgary|Edmonton|Toronto|Vancouver|Winnipeg|Ottawa|Montreal|Montréal|Halifax|Regina|Saskatoon|Victoria)\b/i, "CAD"],
];

export function detectLocationCurrency(text) {
  if (!text) return null;
  for (const [re, code] of LOC_STRONG_RES) if (re.test(text)) return { code, tier: "strong" };
  for (const [re, code] of LOC_MEDIUM_RES) if (re.test(text)) return { code, tier: "medium" };
  return null;
}

// --- cancelled / void detection (round 4, real-03 receipt-4). A cancelled
// slip must never become a spend: PP-OCR read the Shell slip's
// "TRANSACTION CANCELLED" perfectly, yet the parser invented a $10.00
// spend from a misread "TOTAL SALE 10.00" line. Detection is anchored —
// full-line stamps, the "transaction cancelled" phrase, a TRANSACTION
// line directly followed by a CANCELLED line (PP splits the stamp across
// two text lines on that very slip), or a CJK cancellation stamp — so
// prose like "cancellation policy" or "VOID WHERE PROHIBITED" never fires.
const CANCELLED_FULL_LINE_RES = [
  /^transaction\s+cancelled[!.。\s]*$/i,
  /^transaction\s+canceled[!.。\s]*$/i,
  /^cancelled[!.。\s]*$/i,
  /^canceled[!.。\s]*$/i,
  /^void[!.。\s]*$/i,
  /^voided[!.。\s]*$/i,
  /^transaction\s+void(ed)?[!.。\s]*$/i,
];
const CANCELLED_TOKEN_RE = /^(cancelled|canceled|void|voided)[!.。\s]*$/i;

function detectCancelled(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (CANCELLED_FULL_LINE_RES.some((re) => re.test(line))) return true;
    if (/作廢|已取消|交易取消|取消交易/.test(line)) return true;
    // phrase form — but a line about a policy / fee / penalty is prose
    // about cancellations, not a cancelled transaction.
    if (/transaction\s+(cancelled|canceled)\b/i.test(line) &&
        !/policy|fee|penalt|charge/i.test(line)) return true;
    // split stamp: "TRANSACTION" directly followed by "CANCELLED"
    if (/^transaction[!.。\s]*$/i.test(line) && i + 1 < lines.length &&
        CANCELLED_TOKEN_RE.test(lines[i + 1])) return true;
  }
  return false;
}

// --- decoy-digit defence for the amount fallback (round 4, real-02).
// Bare integers (no decimal, no currency marker) sitting on phone / card /
// tax-rate lines, glued onto a word, or followed by "%" are not money:
// Canadian Tire's "amount" came out as its phone number 9550, Partsource's
// as the card last-4 2404 (beating the clean $31.48), Dank's as the 5000
// inside "GST5000V". Decimal / marked tokens are never decoys — a
// "VISA $31.48" line keeps its amount.
const PHONE_LINE_RE = /(?:\(|（)\d{3}(?:\)|）)[\s-]?\d{3}[\s-]\d{4}|\b\d{3}[- ]\d{3}[- ]\d{4}\b|\b\d{3}[- ]\d{4}\b/;
const TEL_LABEL_RE = /\b(?:tel|phone|fax|hotline)\b|電話|傳真/i;
const CARD_LINE_RE = /\*{2,}\s*\d{2,}|\d{2,}\s*\*{2,}|\b(?:visa|mastercard|amex|interac|debit|credit|acct)\b|卡號|卡号/i;
const TAX_RATE_LINE_RE = /\b(?:gst|hst|pst|qst|tax)\b[^0-9]{0,8}\d+(?:\.\d+)?\s*%|稅率|税率/i;

function isDecoyLine(line) {
  return PHONE_LINE_RE.test(line) || TEL_LABEL_RE.test(line) ||
    CARD_LINE_RE.test(line) || TAX_RATE_LINE_RE.test(line);
}

function isDecoyToken(t) {
  return !t.hasDecimal && !t.hasMarker && (t.glued || t.pct || t.decoyLine);
}

// --- fuzzy vendor canonicalisation (round 4). Stylised chain logos are
// read as near-miss garble while the same receipt's totals/dates read
// fine — Goodwill alone came out as "goadwill" / "goaduill" / "gpoduinl"
// across the batches. A conservative edit-distance match against a small
// dictionary of chains seen in the real batches canonicalises the garble;
// it fires only on a near miss (distance ≥ 1 — an exact first word leaves
// the line untouched) and never on text with no chain within reach.
const VENDOR_CHAINS = [
  ["Goodwill", "goodwill"], ["Costco", "costco"], ["Dollarama", "dollarama"],
  ["Value Village", "valuevillage"], ["IKEA", "ikea"], ["Shell", "shell"],
  ["Safeway", "safeway"], ["Canadian Tire", "canadiantire"],
  ["Visions", "visions"], ["Partsource", "partsource"],
  ["Dank Cannabis", "dankcannabis"], ["FOUR20", "four20"],
  ["Kinjo", "kinjo"], ["Starbucks", "starbucks"],
];

function foldOcrName(s) {
  return (s || "").toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "")
    .replace(/0/g, "o").replace(/1/g, "l");
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function chainThreshold(aliasLen) {
  return aliasLen >= 8 ? 3 : aliasLen >= 6 ? 2 : 1;
}

function fuzzyChain(folded) {
  if (!folded || folded.length < 3) return null;
  let best = null;
  for (const [display, alias] of VENDOR_CHAINS) {
    const th = chainThreshold(alias.length);
    if (Math.abs(folded.length - alias.length) > th) continue;
    const d = levenshtein(folded, alias);
    if (d >= 1 && d <= th && (!best || d < best.d)) best = { display, d };
  }
  return best ? best.display : null;
}

function exactChain(folded) {
  const hit = VENDOR_CHAINS.find(([, alias]) => alias === folded);
  return hit ? hit[0] : null;
}

function canonicalVendor(line, lines, idx) {
  const words = line.split(/\s+/).filter(Boolean);
  const foldedWords = words.map(foldOcrName);
  // The line already STARTS with an exact chain name — leave it untouched
  // ("shell Canada", "SAFEWAY", "DOLLARAMA" are correct as read).
  if (foldedWords.length && exactChain(foldedWords[0])) return line;
  // A chain name buried as a later word identifies the shop even when the
  // rest of the line is garble ("K4 Kinjo Districi").
  for (let w = 1; w < foldedWords.length; w++) {
    const hit = exactChain(foldedWords[w]);
    if (hit) return hit;
  }
  const direct = fuzzyChain(foldOcrName(line)) ||
    fuzzyChain(foldOcrName(words.slice(0, 2).join(" "))) ||
    fuzzyChain(foldedWords[0]);
  if (direct) return direct;
  // Slogan / banner lines sit above the real name (real-02 Visions:
  // "Your Best Price!" over a garbled "VisioDs") — scan a few lines down.
  for (let i = idx + 1; i < Math.min(lines.length, idx + 5); i++) {
    const lw = lines[i].split(/\s+/).filter(Boolean);
    if (!lw.length) continue;
    const hit = exactChain(foldOcrName(lw[0])) ||
      exactChain(foldOcrName(lw.slice(0, 2).join(" ")));
    if (hit) return hit;
    const f = fuzzyChain(foldOcrName(lines[i])) ||
      fuzzyChain(foldOcrName(lw.slice(0, 2).join(" "))) ||
      fuzzyChain(foldOcrName(lw[0]));
    if (f) return f;
  }
  return line;
}

// --- vendor sanity + domain fallback (round 5). Hector's first phone
// scan (PartSource, 2026-10-26): the stylised logo banner came back as
// "店 oo =" and the first-substantive-line rule served the garble raw.
// A real shop-name line has substance — letter/CJK characters dominate
// and it never contains "=". Anything else is logo garble, and then the
// receipt's own printed web domain is the better evidence: domains are
// plain ASCII in body type, so they survive OCR far better than logo
// banners ("SEE OUR RETAIL RETURN POLICY AT WWW.PARTSOURCE.CA").
function isSaneVendorName(line) {
  if (!line || /[=＝]/.test(line)) return false;
  let letters = 0, digits = 0, junk = 0;
  for (const ch of line) {
    if (/[a-zA-Z\u3040-\u30ff\u4e00-\u9fff]/.test(ch)) letters++;
    else if (/\d/.test(ch)) digits++;
    else if (/[\s&'’.,·-]/.test(ch)) { /* name punctuation */ }
    else junk++;
  }
  return letters >= 3 && digits + junk <= letters;
}

const DOMAIN_TLDS = new Set([
  "com", "net", "org", "ca", "hk", "jp", "tw", "uk", "io", "co",
  "store", "shop", "biz", "info",
]);
const DOMAIN_SECOND_LEVEL = new Set([
  "com.hk", "com.tw", "com.cn", "co.jp", "co.uk", "com.au",
]);
// Payment-platform domains printed in slip footers are the terminal
// provider (the corpus has "clover.com" on a Kinjo slip), never the shop.
const DOMAIN_DENY_STEMS = new Set([
  "clover", "square", "squareup", "toasttab", "lightspeed",
  "moneris", "paypal", "stripe",
]);

// The shop's web domain as printed on the receipt → a display name.
// OCR spacing around the dots is tolerated ("www . partsource . ca").
// The stem above the TLD is the shop's name; when it lands on the chain
// dictionary (exact or fuzzy), the canonical chain name is used
// (partsource.ca → "Partsource").
export function vendorFromDomain(text) {
  if (!text) return null;
  const tokenRe = /(www\s*\.\s*)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\s*\.\s*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi;
  const candidates = [];
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const parts = m[2].toLowerCase().replace(/\s+/g, "").split(".").filter(Boolean);
    if (parts.length < 2) continue;
    let stem = null;
    if (DOMAIN_SECOND_LEVEL.has(parts.slice(-2).join(".")) && parts.length >= 3) {
      stem = parts[parts.length - 3];
    } else if (DOMAIN_TLDS.has(parts[parts.length - 1])) {
      stem = parts[parts.length - 2];
    }
    if (!stem || stem.length < 3 || /^\d+$/.test(stem)) continue;
    if (DOMAIN_DENY_STEMS.has(stem)) continue;
    candidates.push({ stem, hasWww: !!m[1] });
  }
  if (!candidates.length) return null;
  const pick = candidates.find((c) => c.hasWww) || candidates[0];
  const display = pick.stem.split("-").filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const folded = foldOcrName(display);
  return exactChain(folded) || fuzzyChain(folded) || display;
}

// --- category suggestion (round 5). Hector: "classification seem always
// wrong, better be null." There was never a guesser in the parser — the
// confirm form simply sat on the select's first option （餐飲）. The
// suggestion below is therefore deliberately stingy: it fires only on
// explicit evidence, and otherwise stays null (the form then shows
// 未分類 and the user picks):
//   1. the vendor IS a chain whose trade is unambiguous (Starbucks /
//      McDonald's / Tim Hortons / KFC → 餐飲， Shell → 交通， IKEA → 家居）;
//   2. the vendor NAME carries its trade （餐廳/拉麵/cafe/coffee…,
//      加油站/petrol…);
//   3. the goods are fuel (gasoline / unleaded / 汽油 / 柴油 — searched
//      outside the vendor line, so a brand named Diesel cannot misfire).
// Everything else — supermarkets, warehouses, thrift, auto parts
// (PartSource: "LAMP BUL / WIPER BLAD") — stays null.
const CATEGORY_CHAIN_MAP = [
  ["starbucks", "餐飲"], ["mcdonalds", "餐飲"], ["timhortons", "餐飲"],
  ["kfc", "餐飲"], ["shell", "交通"], ["ikea", "家居"],
];
const FOOD_NAME_RE = /餐廳|餐馆|茶餐廳|冰室|食堂|麵家|麵館|拉麵|拉麺|壽司|咖啡|烘焙|麵包|restaurant|cafe|café|coffee|bakery|ramen|sushi|pizza|burger|diner|noodle|kitchen/i;
const FUEL_NAME_RE = /加油站|油站|petrol|gas\s*station|加油/i;
const FUEL_GOODS_RE = /\b(?:gasoline|unleaded|fuel)\b|汽油|柴油/i;

function suggestCategory(vendor, lines, vendorIdx) {
  if (vendor) {
    const words = vendor.split(/\s+/).filter(Boolean);
    const folds = [
      foldOcrName(vendor),
      foldOcrName(words[0] || ""),
      foldOcrName(words.slice(0, 2).join(" ")),
    ];
    for (const [alias, cat] of CATEGORY_CHAIN_MAP) {
      if (folds.includes(alias)) return cat;
    }
    if (FOOD_NAME_RE.test(vendor)) return "餐飲";
    if (FUEL_NAME_RE.test(vendor)) return "交通";
  }
  const body = lines.filter((_, i) => i !== vendorIdx).join("\n");
  if (FUEL_GOODS_RE.test(body)) return "交通";
  return null;
}

export function parseReceiptText(text) {
  const result = {
    vendor: null, amount: null, currency: null, currencySource: null,
    date: null, cancelled: false, totalFound: false, category: null,
  };
  if (!text || !text.trim()) return result;
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // --- cancelled / void: amount extraction is suppressed entirely — the
  // slip's date / vendor / currency still parse (context for the user),
  // but no amount means the confirm sheet can never silently import a
  // spend that did not happen.
  result.cancelled = detectCancelled(lines);

  // --- amount: total-evidence lines first, then largest plausible overall.
  // Evidence = TOTAL-family keyword lines + payment-block AMOUNT lines.
  // Subtotal lines are DEMOTED out of the evidence pool: "SUBTOTAL"
  // contains "total", but a subtotal is explicitly not the total — leaving
  // it in let Costco's subtotal (148.91) beat its own TOTAL line and hide
  // the charged AMOUNT (149.88) behind the keyword wall (real-01).
  const evidenceValues = [];
  const allValues = [];
  let zeroTotal = false;      // an explicit TOTAL of 0.00 was printed
  let positiveTotalKw = false; // a TOTAL-keyword line carries a value > 0
  if (!result.cancelled) {
    for (const line of lines) {
      const low = line.toLowerCase();
      // Test keywords on the line with subtotal phrases stripped, so a
      // subtotal line's only "total" hit (the one inside "subtotal") cannot
      // claim evidence; a line carrying a real TOTAL keyword still can.
      const lowNoSub = low.replace(/sub[\s-]?total/g, "");
      const hasTotalKw =
        TOTAL_KEYWORDS_CJK.some((k) => lowNoSub.includes(k)) ||
        TOTAL_LATIN_RES.some((re) => re.test(lowNoSub)) || TOTAL_ABBR_RE.test(lowNoSub);
      const hasPaidAmount = AMOUNT_PAID_RE.test(low) && !AMOUNT_NOT_PAID_RE.test(low);
      // An explicit TOTAL of 0.00 is a real total (real-02 Visions
      // net-zero exchange — "Total: 0.00" printed three times) — admit
      // zero tokens on total-keyword lines into the pools. Everywhere
      // else a zero stays implausible, so decoy 0.00s (CHANGE lines and
      // the like) still can't enter.
      const toks = moneyTokens(line).filter(
        (t) => isPlausibleTotal(t, line) ||
          (hasTotalKw && t.value === 0 && (t.hasDecimal || t.hasMarker)));
      const decoyLine = isDecoyLine(line);
      for (const t of toks) { t.decoyLine = decoyLine; allValues.push(t); }
      if (hasTotalKw || hasPaidAmount) evidenceValues.push(...toks);
      if (hasTotalKw) {
        if (toks.some((t) => t.value > 0)) positiveTotalKw = true;
        // A TOTAL-keyword line printing an explicit 0.00 — unless the
        // line is about a discount / saving / tender, where 0.00 is not
        // the charge.
        if (!/discount|savings?|saved|rebate|change|tendered/i.test(low) &&
            toks.some((t) => t.value === 0 && (t.hasDecimal || t.hasMarker))) {
          zeroTotal = true;
        }
      }
    }
  }
  const pickLargest = (arr) => (arr.length ? Math.max(...arr) : null);
  if (zeroTotal && !positiveTotalKw) {
    // The receipt's own TOTAL says 0.00 and no TOTAL line says otherwise:
    // the total IS zero — it must not lose to a neighbouring AMOUNT /
    // line-item value the way Visions' 0.00 lost to a 2.75 surcharge.
    // (When a TOTAL line does carry a positive value, the merged-pool
    // rule below stays in charge — the round-2 Costco behaviour, where
    // the charged AMOUNT beats a smudge-misread TOTAL, is untouched.)
    result.amount = 0;
    result.totalFound = true;
  } else if (evidenceValues.length) {
    const dec = evidenceValues.filter((t) => t.hasDecimal || t.hasMarker);
    result.amount = pickLargest((dec.length ? dec : evidenceValues).map((t) => t.value));
    result.totalFound = true;
  } else if (allValues.length) {
    // Fallback pool, decoy-hardened (round 4): phone fragments, card
    // last-4s, word-glued code chunks and %-rates are excluded first.
    // Sanity cap on the fallback only: when the receipt writes money with
    // decimals, a bare integer ≥ 10000 (no decimal point, no currency
    // marker) is a timestamp / serial / phone chunk, not a total — never
    // let it win. Benchmark traps: "03:29PM 562936" over RM 169.80, GST-no
    // chunk "52800" over RM 1.00. Decimal-free receipts (e.g. JPY, where
    // bare integers ARE money) never trigger the cap.
    let pool = allValues.filter((t) => !isDecoyToken(t));
    if (pool.some((t) => t.hasDecimal)) {
      pool = pool.filter((t) => t.hasDecimal || t.hasMarker || t.value < 10000);
    }
    // Same decimal preference as the evidence branch: when the receipt
    // writes money with decimals, a bare integer is a code fragment,
    // not the largest amount (real-02: Costco #543's fallback picked
    // the serial 6028 over the printed 114.78; Partsource's picked the
    // AID fragment 1010 over $31.48). Decimal-free receipts (JPY-style)
    // have no decimal tokens, so their bare integers still compete.
    const dec = pool.filter((t) => t.hasDecimal || t.hasMarker);
    result.amount = pickLargest((dec.length ? dec : pool).map((t) => t.value));
  }

  // --- date
  result.date = findDate(text);

  // --- currency: store location vs symbol/code (round 3). STRONG location
  // evidence beats the symbol (the symbol is the garble-prone signal);
  // an explicit symbol beats MEDIUM location evidence; medium evidence
  // fills in only when no symbol was read. currencySource records which
  // signal decided ("symbol" | "location" | null).
  const symbolCurrency = findCurrency(text);
  const locCurrency = detectLocationCurrency(text);
  if (locCurrency && locCurrency.tier === "strong") {
    result.currency = locCurrency.code;
    result.currencySource = "location";
  } else if (symbolCurrency) {
    result.currency = symbolCurrency;
    result.currencySource = "symbol";
  } else if (locCurrency) {
    result.currency = locCurrency.code;
    result.currencySource = "location";
  }

  // --- vendor: first substantive line that isn't a date / phone / pure
  // number line — and isn't greeting / copy furniture. "WELCOME",
  // "THANK YOU", "CUSTOMER COPY", 歡迎光臨, 多謝惠顧 are never the shop
  // name (real-01: Shell's line 1 is "WELCOME", the shop is line 2).
  // Anchored full-line matches only, so a real name that merely contains
  // these words is untouched.
  const VENDOR_SKIP_RES = [
    /^welcome[!.。\s]*$/i,
    /^thank\s*you[!.。\s]*$/i,
    /^thanks[!.。\s]*$/i,
    /^please\s+come\s+again[!.。\s]*$/i,
    /^customer\s+copy[!.。\s]*$/i,
    /^cardholder\s+copy[!.。\s]*$/i,
    /^(歡迎光臨|歡迎|多謝惠顧|謝謝惠顧|顧客存根|客戶存根)[!.。\s]*$/,
    // Slip-header furniture (round 4): card slips print TRANSACTION
    // RECORD where a shop name would go (real-02 Partsource, real-03
    // Spyhill Landfill). The loose \w* also catches the glued / mangled
    // reads: TRANSACTIONRECORD, TRANSACTONRECORD, TRANSHCTION RECORD.
    /^[^\w\u4e00-\u9fff]*trans\w*\s*record[!.。\s]*$/i,
    // QR review caption printed above the shop name (round 4, real-03
    // Dank Cannabis; real-02 Dank B had the same trap). The loose final
    // \w also catches the observed misread "LEAVE A REVIEN".
    /^[^\w\u4e00-\u9fff]*leave\s*a\s*revie\w[!.。\s]*$/i,
  ];
  let vendorIdx = -1;
  let pickedLine = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (VENDOR_SKIP_RES.some((re) => re.test(line))) continue;
    if (parseDateString(line) && line.replace(/[\d\-/年月日\s]/g, "").length < 3) continue;
    if (/^(tel|電話|phone|fax|傳真)[:：]?\s*[\d\s-]+$/i.test(line)) continue;
    if (/^[\d\s\-+()]+$/.test(line)) continue;
    if (/^(receipt|收據|發票|invoice|cashier|收銀)/i.test(line) && line.length < 12) continue;
    pickedLine = line.slice(0, 40);
    vendorIdx = i;
    break;
  }
  // Vendor precedence (round 5): a top-line name that passes the sanity
  // check stays (with the round-4 fuzzy canonicalisation applied, as
  // before). A garbage or missing line-pick is never served raw: a chain
  // identity recovered from the line itself still wins (position
  // evidence), then the receipt's printed domain, else null — the
  // confirm form leaves the field blank rather than inventing a name.
  if (pickedLine && isSaneVendorName(pickedLine)) {
    result.vendor = canonicalVendor(pickedLine, lines, vendorIdx);
  } else {
    let recovered = null;
    if (pickedLine) {
      const c = canonicalVendor(pickedLine, lines, vendorIdx);
      if (c !== pickedLine) recovered = c;
    }
    if (!recovered && pickedLine) {
      // Symbol-polluted name fragment ("===WHOLESALE" on a Tesseract
      // Costco text): the longest letter run, when substantive, is the
      // name the garble buried. Short runs ("店 oo =") salvage nothing.
      const runs = pickedLine.match(/[a-zA-Z\u3040-\u30ff\u4e00-\u9fff]{4,}/g);
      if (runs) {
        const longest = runs.reduce((a2, b2) => (b2.length > a2.length ? b2 : a2));
        recovered = canonicalVendor(longest, lines, vendorIdx);
      }
    }
    result.vendor = recovered || vendorFromDomain(text);
  }

  // --- category: high-confidence suggestion only, else null (round 5)
  result.category = suggestCategory(result.vendor, lines, vendorIdx);
  return result;
}

// ---------- CSV ----------

// minimal RFC4180-ish CSV tokenizer (handles quotes, commas, newlines in quotes)
export function splitCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

const HEADER_ALIASES = {
  date: ["date", "日期", "交易日期", "消費日期", "day", "日付", "注文日"],
  vendor: ["vendor", "description", "merchant", "商戶", "商店", "描述", "名稱", "店名", "payee", "item", "商品", "商品名"],
  amount: ["amount", "金額", "價錢", "價格", "total", "總額", "spend", "支出", "合計", "落札価格"],
  currency: ["currency", "幣別", "貨幣", "幣種", "curr", "ccy", "通貨"],
  category: ["category", "分類", "類別", "类别"],
  note: ["note", "備註", "备注", "memo", "notes"],
};

function detectHeader(cells) {
  const map = {};
  const lower = cells.map((c) => String(c).trim().toLowerCase());
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    lower.forEach((c, i) => {
      if (aliases.includes(c) && map[field] === undefined) map[field] = i;
    });
  }
  return map.date !== undefined && map.amount !== undefined ? map : null;
}

function cleanAmount(v) {
  if (v === undefined || v === null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n !== 0 ? Math.abs(n) : null;
}

// Normalize a currency cell / token to an ISO code. Handles ISO codes,
// symbols (¥/円→JPY, HK$→HKD, NT$→TWD, US$→USD, CA$→CAD, £, €) and words.
export function normalizeCurrencyToken(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const up = s.toUpperCase();
  if (CURRENCIES.includes(up)) return up;
  if (/HK\$/.test(s)) return "HKD";
  if (/NT\$/.test(s)) return "TWD";
  if (/US\$/.test(s)) return "USD";
  if (/CA\$/.test(s)) return "CAD";
  if (/[¥円]/.test(s)) return "JPY";
  if (/£/.test(s)) return "GBP";
  if (/€/.test(s)) return "EUR";
  return findCurrency(s);
}

function cleanCurrency(v) {
  return normalizeCurrencyToken(v);
}

export function parseCSV(text) {
  const rows = splitCSV(text).filter((r) => r.some((c) => String(c).trim() !== ""));
  if (!rows.length) return [];
  const header = detectHeader(rows[0]);
  const out = [];
  const start = header ? 1 : 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    let rec;
    if (header) {
      rec = {
        date: parseDateString(r[header.date]),
        vendor: (r[header.vendor] ?? "").trim(),
        amount: cleanAmount(r[header.amount]),
        currency: cleanCurrency(r[header.currency]), // null when undetected — caller applies fallback
        category: (r[header.category] ?? "").trim(),
        note: (r[header.note] ?? "").trim(),
      };
    } else {
      // position fallback: date, vendor, amount, [currency], [category]
      rec = {
        date: parseDateString(r[0]),
        vendor: (r[1] ?? "").trim(),
        amount: cleanAmount(r[2]),
        currency: cleanCurrency(r[3]), // null when undetected — caller applies fallback
        category: cleanCurrency(r[3]) ? (r[4] ?? "").trim() : (r[3] ?? "").trim(),
        note: "",
      };
    }
    if (!rec.date || rec.amount === null) continue;
    if (!rec.vendor) rec.vendor = "（未命名）";
    if (!CATEGORIES.includes(rec.category)) rec.category = "其他";
    out.push(rec);
  }
  return out;
}

// ---------- JSON ----------

// Bilingual, case-insensitive key map. Keys are normalized by lowercasing and
// stripping spaces/underscores, so orderDate / order_date / Order Date all hit.
const JSON_KEYS = {
  date: ["date", "日期", "日付", "orderdate", "注文日"],
  amount: ["amount", "金額", "価格", "total", "price", "合計", "落札価格", "payment"],
  vendor: ["vendor", "title", "item", "商品", "商品名", "name", "description"],
  currency: ["currency", "幣別", "通貨"],
};

function normKey(k) {
  return String(k).trim().toLowerCase().replace(/[\s_]+/g, "");
}

export function parseJSON(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch {
    return [];
  }
  let items = null;
  if (Array.isArray(data)) {
    items = data;
  } else if (data && typeof data === "object") {
    for (const k of ["orders", "items", "results"]) {
      if (Array.isArray(data[k])) { items = data[k]; break; }
    }
    if (!items) {
      for (const v of Object.values(data)) {
        if (Array.isArray(v)) { items = v; break; }
      }
    }
  }
  if (!items) return [];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const byKey = {};
    for (const [k, v] of Object.entries(item)) byKey[normKey(k)] = v;
    const pick = (aliases) => {
      for (const a of aliases) {
        const v = byKey[a];
        if (v !== undefined && v !== null && v !== "") return v;
      }
      return undefined;
    };
    const rawAmount = pick(JSON_KEYS.amount);
    const date = parseDateString(pick(JSON_KEYS.date));
    const amount = cleanAmount(rawAmount);
    if (!date || amount === null) continue;
    let currency = normalizeCurrencyToken(pick(JSON_KEYS.currency));
    if (!currency && rawAmount !== undefined) {
      currency = normalizeCurrencyToken(rawAmount) || findCurrency(String(rawAmount));
    }
    const vendorRaw = pick(JSON_KEYS.vendor);
    const vendor = vendorRaw !== undefined ? String(vendorRaw).trim() : "";
    out.push({
      date,
      vendor: (vendor || "（未命名）").slice(0, 60),
      amount,
      currency, // null when undetected — caller applies fallback
      category: "購物",
      note: "",
    });
  }
  return out;
}

// ---------- HTML (saved order-history pages, e.g. Buyee / Jauce) ----------
// Works on raw HTML text (no DOM) so it stays unit-testable in node.

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

function cellText(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function extractTableRows(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cells = [];
    const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) cells.push(cellText(c[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

const HTML_HEADER_ALIASES = {
  date: ["日付", "注文日", "購入日", "落札日", "日期", "交易日", "日時", "date"],
  vendor: ["商品名", "商品", "品名", "出品名", "名稱", "名前", "item", "title", "name"],
  amount: ["落札価格", "支払金額", "購入金額", "金額", "価格", "合計", "amount", "price", "total"],
  currency: ["通貨", "幣別", "貨幣", "currency"],
};

function headerCellMatches(cellLower, alias) {
  if (/[^\x00-\x7F]/.test(alias)) return cellLower.includes(alias); // CJK: substring
  return new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`).test(cellLower); // latin: whole word
}

function matchHTMLHeader(cells) {
  const map = {};
  cells.forEach((cell, i) => {
    const c = cell.toLowerCase();
    for (const [field, aliases] of Object.entries(HTML_HEADER_ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.some((a) => headerCellMatches(c, a))) map[field] = i;
    }
  });
  return map.date !== undefined && map.amount !== undefined ? map : null;
}

function parseHTMLTables(html) {
  const out = [];
  let map = null;
  for (const cells of extractTableRows(html)) {
    const h = matchHTMLHeader(cells);
    if (h) { map = h; continue; }
    if (!map) continue;
    const date = parseDateString(cells[map.date]);
    const amount = cleanAmount(cells[map.amount]);
    if (!date || amount === null) continue;
    const vendorRaw = map.vendor !== undefined ? (cells[map.vendor] || "").trim() : "";
    let currency = null;
    if (map.currency !== undefined) currency = normalizeCurrencyToken(cells[map.currency]);
    if (!currency) currency = normalizeCurrencyToken(cells[map.amount]) || findCurrency(cells[map.amount] || "");
    out.push({
      date,
      vendor: (vendorRaw || "（未命名）").slice(0, 60),
      amount,
      currency, // null when undetected — caller applies fallback (JPY for HTML)
      category: "購物",
      note: "",
    });
  }
  return out;
}

const LINE_MONEY_RE = /(HK\$|US\$|NT\$|CA\$|¥|円|\$|£|€)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2}|\d{3,})(?:\s*円)?/g;

// Fallback when no order table matches: pair a date line with a money amount
// on the same or the next two lines.
function parseHTMLLines(html) {
  const text = decodeEntities(String(html).replace(/<[^>]*>/g, "\n"));
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const date = parseDateString(lines[i]);
    if (!date) continue;
    let amount = null, currency = null, usedLine = -1;
    for (let j = i; j < Math.min(i + 3, lines.length) && amount === null; j++) {
      LINE_MONEY_RE.lastIndex = 0;
      let m;
      while ((m = LINE_MONEY_RE.exec(lines[j])) !== null) {
        const v = parseFloat(m[2].replace(/,/g, ""));
        if (!Number.isFinite(v) || v <= 0 || v >= 1000000) continue;
        if (String(Math.trunc(v)) === date.slice(0, 4) && !m[1]) continue; // the year itself
        amount = v;
        currency = normalizeCurrencyToken(m[1] || lines[j]) || findCurrency(lines[j]);
        usedLine = j;
        break;
      }
    }
    if (amount === null) continue;
    let vendor = "";
    for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
      if (!parseDateString(lines[k]) && lines[k].replace(/[\d\s\-/.,:：]/g, "").length >= 2) {
        vendor = lines[k];
        break;
      }
    }
    out.push({
      date,
      vendor: (vendor || "（未命名）").slice(0, 60),
      amount,
      currency,
      category: "購物",
      note: "",
    });
    if (usedLine > i) i = usedLine;
  }
  return out;
}

export function parseHTML(html) {
  if (!html) return [];
  const cleaned = String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const fromTables = parseHTMLTables(cleaned);
  if (fromTables.length) return fromTables;
  return parseHTMLLines(cleaned);
}

// ---------- dedupe ----------

export function dedupeKey(rec) {
  return `${rec.date}|${Number(rec.amount).toFixed(2)}|${String(rec.vendor).trim().toLowerCase()}`;
}

export function filterNewRecords(existing, incoming) {
  const seen = new Set(existing.map(dedupeKey));
  const toAdd = [];
  let skipped = 0;
  for (const rec of incoming) {
    const k = dedupeKey(rec);
    if (seen.has(k)) { skipped++; continue; }
    seen.add(k);
    toAdd.push(rec);
  }
  return { toAdd, skipped };
}
