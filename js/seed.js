// OneSpends — demo seed for design preview.
// /app?demo=1  → load SEED_SPENDS into a SEPARATE IndexedDB database ("onespends-demo")
//                and flag localStorage 'onespends_demo'='1'.
// /app (normal) → if the demo flag is set, delete the demo database and clear the flag.
// The user's real database ("onespends") is never read or written in demo mode.
import { SEED_SPENDS } from "./seed-data.js";
import { useDatabase, deleteDatabase, clearAllSpends, addManySpends, DEFAULT_DB } from "./db.js";

const FLAG = "onespends_demo";
export const DEMO_DB = "onespends-demo";

function flagGet() { try { return localStorage.getItem(FLAG); } catch { return null; } }
function flagSet(on) {
  try { on ? localStorage.setItem(FLAG, "1") : localStorage.removeItem(FLAG); } catch { /* private mode */ }
}

export function isDemoURL() {
  return new URLSearchParams(location.search).get("demo") === "1";
}

const isoDay = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toISO = (ms) => new Date(ms).toISOString().slice(0, 10);

// Shift the sample so its newest record lands on today — the demo always looks "live".
function rebaseToToday(list) {
  const latest = Math.max(...list.map((r) => isoDay(r.date)));
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = today - latest;
  return list.map((r) => ({ ...r, date: toISO(isoDay(r.date) + shift) }));
}

/**
 * The demo dataset as in-memory records shaped like stored spends
 * (id / createdAt / source included), rebased to today and sorted the way
 * db.getAllSpends sorts. Used by the tour's render-layer preview (js/app.js):
 * nothing here touches any database.
 */
export function demoRecords() {
  const now = Date.now();
  return rebaseToToday(SEED_SPENDS)
    .map((r, i) => ({ id: `preview-${i + 1}`, createdAt: now - i, ...r, source: "demo" }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
}

/** Call before the first DB read. Returns true when running in demo mode. */
export async function prepareDataSource() {
  if (isDemoURL()) {
    useDatabase(DEMO_DB);
    flagSet(true);
    await clearAllSpends();
    await addManySpends(rebaseToToday(SEED_SPENDS).map((r) => ({ ...r, source: "demo" })));
    return true;
  }
  useDatabase(DEFAULT_DB);
  if (flagGet() === "1") {
    await deleteDatabase(DEMO_DB);
    flagSet(false);
  }
  return false;
}
