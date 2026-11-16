// OneSpends — IndexedDB storage (all data stays on this device; cloud sync
// in js/sync.js mirrors it to the user's account when they sign in).
export const DEFAULT_DB = "onespends";
const STORE = "spends";
let DB_NAME = DEFAULT_DB;

// Switch which IndexedDB database the helpers below read/write.
// Demo mode (js/seed.js) uses a separate database so real records are never touched.
export function useDatabase(name) { DB_NAME = name || DEFAULT_DB; }
export function currentDatabase() { return DB_NAME; }

// Optional hook fired after every LOCAL mutation (never for sync-applied
// writes). js/sync.js registers it to schedule an auto-sync.
let changeHook = null;
export function setChangeHook(fn) { changeHook = fn; }
function notifyChange() {
  if (!changeHook) return;
  try { changeHook(); } catch { /* a sync scheduling bug must not break writes */ }
}

// ----- delete tombstones -----
// Hard-deleting from IndexedDB would make a deletion invisible to sync, so
// local deletes also leave a tombstone {id, updatedAt} in localStorage
// (scoped per database). js/sync.js pushes them, then clears them.
const tombstoneKey = () => `onespends_tombstones:${DB_NAME}`;
export function getTombstones() {
  try { return JSON.parse(localStorage.getItem(tombstoneKey()) || "[]"); }
  catch { return []; }
}
function addTombstone(id, updatedAt) {
  const list = getTombstones().filter((t) => t.id !== id);
  list.push({ id, updatedAt });
  try { localStorage.setItem(tombstoneKey(), JSON.stringify(list)); } catch { /* full/blocked storage: sync just misses this delete */ }
}
export function removeTombstones(ids) {
  const drop = new Set(ids);
  const list = getTombstones().filter((t) => !drop.has(t.id));
  try { localStorage.setItem(tombstoneKey(), JSON.stringify(list)); } catch { /* ignore */ }
}

export function deleteDatabase(name) {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("date", "date", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllSpends() {
  const db = await openDB();
  const all = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  db.close();
  return all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
}

function newId(now) {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${now}-${Math.random().toString(36).slice(2)}`;
}

export async function addSpend(rec) {
  const db = await openDB();
  const now = Date.now();
  const record = {
    id: newId(now),
    createdAt: now,
    updatedAt: now,
    ...rec,
  };
  await reqToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).add(record));
  db.close();
  notifyChange();
  return record;
}

export async function addManySpends(recs) {
  const db = await openDB();
  const t = db.transaction(STORE, "readwrite");
  const store = t.objectStore(STORE);
  const now = Date.now();
  for (const rec of recs) {
    store.add({
      id: newId(now),
      createdAt: now,
      updatedAt: now,
      ...rec,
    });
  }
  await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); });
  db.close();
  notifyChange();
}

export async function updateSpend(id, rec) {
  const db = await openDB();
  const existing = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
  if (!existing) { db.close(); return; }
  // updatedAt is the sync clock: a local edit stamps now; a caller passing an
  // explicit updatedAt (sync apply) keeps the remote value.
  const merged = { ...existing, ...rec, id, updatedAt: rec.updatedAt ?? Date.now() };
  await reqToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).put(merged));
  db.close();
  notifyChange();
  return merged;
}

export async function deleteSpend(id) {
  const db = await openDB();
  await reqToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
  db.close();
  addTombstone(id, Date.now());
  notifyChange();
}

// ----- sync-applied writes (no updatedAt re-stamp, no tombstone, no hook) -----

/** Insert or overwrite a record exactly as the server version dictates. */
export async function upsertSpendFromSync(rec) {
  const db = await openDB();
  await reqToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).put({ ...rec }));
  db.close();
}

export async function deleteSpendFromSync(id) {
  const db = await openDB();
  await reqToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
  db.close();
}

export async function clearAllSpends() {
  const db = await openDB();
  await reqToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
  db.close();
  notifyChange();
}
