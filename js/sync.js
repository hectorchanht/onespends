// OneSpends — account + cloud sync engine.
//
// Local-first stands: with no account, everything works exactly as before
// and this module stays inert. Signing in (Dawn Studio FULL MAGIC — one
// email carries both a sign-in link and a 6-digit code) turns on mirroring
// of the local IndexedDB data to the user's rows in D1 via /api/sync.
// Merge rules live in js/sync-core.js (pure, unit-tested); this module is
// the I/O: fetch, IndexedDB application, scheduling, UI state snapshots.
//
// Sign-out stops sync; local data stays on the device, untouched. When the
// 90-day trial ends the server refuses sync (403) and the engine pauses —
// nothing is deleted anywhere, local use continues.

import {
  getAllSpends,
  upsertSpendFromSync,
  deleteSpendFromSync,
  getTombstones,
  removeTombstones,
  setChangeHook,
  currentDatabase,
  DEFAULT_DB,
} from "./db.js";
import { planPush, planApply, recordUpdatedAt } from "./sync-core.js";

const STATE_KEY = "onespends_sync_state"; // { email, cursor, synced: {id: updatedAt} }
const ACCOUNT_KEY = "onespends_account"; // cached /me for instant UI paint

function load(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

let callbacks = { onState: () => {}, onData: () => {}, enabled: () => true };
let account = load(ACCOUNT_KEY); // null | { email, trialEndsAt, plan }
let state = load(STATE_KEY) || { email: null, cursor: 0, synced: {} };
if (!state.synced) state.synced = {};
let status = account ? "idle" : "signed-out";
let lastSyncAt = 0;
let syncing = false;
let pendingSync = false;
let debounceTimer = null;

export function getState() {
  return { account, status, lastSyncAt };
}

function setStatus(next) {
  if (status === next) return;
  status = next;
  callbacks.onState();
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  return { res, data };
}

// ---------- account ----------

export async function refreshAccount() {
  try {
    const { res, data } = await api("/api/auth/me");
    if (res.status === 401) {
      account = null;
      save(ACCOUNT_KEY, null);
      setStatus("signed-out");
      return null;
    }
    if (!res.ok || !data) return account;
    const isNewUser = state.email !== data.email;
    account = { email: data.email, trialEndsAt: data.trialEndsAt, plan: data.plan };
    save(ACCOUNT_KEY, account);
    if (isNewUser) {
      // A different account on this device starts from a clean sync slate:
      // local records stay and merge into the new account on first sync.
      state = { email: data.email, cursor: 0, synced: {} };
      save(STATE_KEY, state);
      const tombs = getTombstones();
      if (tombs.length) removeTombstones(tombs.map((t) => t.id));
    }
    setStatus(account.plan === "trial" ? "idle" : "trial-ended");
    return account;
  } catch {
    return account; // offline: keep the cached picture
  }
}

export async function requestLink(email) {
  const { res, data } = await api("/api/auth/request", { method: "POST", body: { email } });
  return res.ok ? { ok: true } : { ok: false, error: (data && data.error) || "send-failed" };
}

export async function verifyCode(email, code) {
  const { res, data } = await api("/api/auth/verify", { method: "POST", body: { email, code } });
  if (!res.ok) return { ok: false, error: (data && data.error) || "invalid-code" };
  await refreshAccount();
  syncNow();
  callbacks.onState();
  return { ok: true };
}

export async function verifyLinkToken(token) {
  const { res, data } = await api("/api/auth/verify-link", { method: "POST", body: { token } });
  if (!res.ok) return { ok: false, error: (data && data.error) || "invalid-token" };
  await refreshAccount();
  syncNow();
  callbacks.onState();
  return { ok: true };
}

/** If the page URL carries a magic-link token, redeem it and scrub the URL. */
export async function handleMagicLinkFromUrl() {
  const url = new URL(location.href);
  const token = url.searchParams.get("token");
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  url.searchParams.delete("token");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  const r = await verifyLinkToken(token);
  return r.ok;
}

export async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* already gone */ }
  account = null;
  save(ACCOUNT_KEY, null);
  setStatus("signed-out");
  callbacks.onState();
}

// ---------- sync ----------

function pauseForTrialEnd() {
  if (account) { account.plan = "free"; save(ACCOUNT_KEY, account); }
  setStatus("trial-ended");
  callbacks.onState();
}

export async function syncNow() {
  if (syncing) { pendingSync = true; return; }
  if (!account || !callbacks.enabled() || currentDatabase() !== DEFAULT_DB) return;
  if (account.plan !== "trial") { setStatus("trial-ended"); return; }
  syncing = true;
  setStatus("syncing");
  try {
    // PUSH: local records + tombstones the server hasn't acknowledged.
    const locals = await getAllSpends();
    const plan = planPush(locals, getTombstones(), state.synced);
    for (let i = 0; i < plan.length; i += 200) {
      const chunk = plan.slice(i, i + 200);
      const { res } = await api("/api/sync", { method: "PUT", body: { records: chunk } });
      if (res.status === 403) { pauseForTrialEnd(); return; }
      if (!res.ok) throw new Error("push " + res.status);
      for (const r of chunk) state.synced[r.id] = r.updatedAt;
      const pushedTombs = chunk.filter((r) => r.deleted).map((r) => r.id);
      if (pushedTombs.length) removeTombstones(pushedTombs);
      save(STATE_KEY, state);
    }
    // PULL: apply every remote version newer than the local copy, in order.
    for (let guard = 0; guard < 10; guard++) {
      const { res, data } = await api(`/api/sync?since=${state.cursor}`);
      if (res.status === 403) { pauseForTrialEnd(); return; }
      if (!res.ok || !data) throw new Error("pull " + res.status);
      const rows = data.records || [];
      if (rows.length) {
        const current = await getAllSpends();
        const byId = new Map(current.map((r) => [r.id, r]));
        const { upserts, deletes } = planApply(byId, rows);
        for (const u of upserts) await upsertSpendFromSync(u);
        for (const d of deletes) await deleteSpendFromSync(d);
        for (const row of rows) {
          const local = byId.get(row.recordId);
          const localU = local ? recordUpdatedAt(local) : -1;
          if (row.deleted) {
            if (!local || localU <= row.updatedAt) state.synced[row.recordId] = row.updatedAt;
          } else if (row.updatedAt >= localU) {
            state.synced[row.recordId] = row.updatedAt;
          }
        }
        if (upserts.length || deletes.length) callbacks.onData();
      }
      const next = Number.isFinite(data.cursor) ? data.cursor : state.cursor;
      const advanced = next !== state.cursor;
      state.cursor = next;
      save(STATE_KEY, state);
      if (!rows.length || !advanced) break;
    }
    lastSyncAt = Date.now();
    setStatus(navigator.onLine ? "synced" : "offline");
    callbacks.onState();
  } catch {
    setStatus(navigator.onLine ? "error" : "offline");
    callbacks.onState();
  } finally {
    syncing = false;
    if (pendingSync) {
      pendingSync = false;
      scheduleSync(400);
    }
  }
}

export function scheduleSync(ms = 1200) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { syncNow().catch(() => {}); }, ms);
}

// ---------- wiring ----------

export function initSync(cbs) {
  callbacks = { ...callbacks, ...cbs };
  setChangeHook(() => { if (callbacks.enabled()) scheduleSync(); });
  window.addEventListener("online", () => { syncNow().catch(() => {}); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncNow().catch(() => {});
  });
  refreshAccount()
    .then(() => { if (account) syncNow().catch(() => {}); })
    .catch(() => {})
    .finally(() => callbacks.onState());
}
