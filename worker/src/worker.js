// OneSpends API — standalone Worker `onespends-api`, routed on
// onespends.dawnstudio.app/api/* (zone route), while the PWA itself stays a
// pure static Pages direct-upload. (A Pages _worker.js was tried first: the
// raw assets-API upload flow serves it as a plain static file and never
// activates advanced mode — see ARCHITECTURE.md. The route split keeps the
// site pipeline byte-for-byte what it always was.)
//
// Auth is the house standard @dawn-studio/auth (FULL MAGIC: one email carries
// both the sign-in link and the 6-digit code; 15-min, single-use, either
// credential burns the other; 30-day httpOnly session cookie). No allowlist —
// any email creates an account on first verify, with a 90-day full trial
// (standing rule for new apps) recorded on the users row.
//
// Sync is per-user, append-only versions in D1 (see schema.sql): a write is
// appended only when its updated_at beats the record's latest version
// (last-write-wins); deletes are tombstone versions in the same log.

import {
  defineAuth,
  createD1Store,
  requestMagicLink,
  verifyMagicToken,
  verifyCode,
  getSessionUser,
  destroySession,
  sessionCookie,
  requestIp,
} from "@dawn-studio/auth";

const TRIAL_MS = 90 * 24 * 3600 * 1000;
const SYNC_PULL_LIMIT = 2000;
const SYNC_PUSH_LIMIT = 500;

function makeCfg(env) {
  return defineAuth({
    appName: "OneSpends",
    domain: "dawnstudio.app",
    from: "Dawn Studio <login@dawnstudio.app>",
    resendApiKey: env.RESEND_API_KEY,
    magicPagePath: "/app",
    cookieName: "onespends_session",
  });
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Session user + trial fields (the lib's AccountUser is id/email only). */
async function currentUser(env, request) {
  const cfg = makeCfg(env);
  const store = createD1Store(env.DB);
  const user = await getSessionUser(store, cfg, request);
  if (!user) return null;
  const row = await env.DB
    .prepare("SELECT created_at, trial_ends_at FROM users WHERE id = ?")
    .bind(user.id)
    .first();
  return {
    id: user.id,
    email: user.email,
    trialEndsAt: row && row.trial_ends_at != null ? Number(row.trial_ends_at) : null,
  };
}

function planOf(user, now) {
  return user.trialEndsAt != null && now < user.trialEndsAt ? "trial" : "free";
}

/** First verify stamps the trial window; COALESCE keeps it idempotent. */
async function ensureTrial(env, userId) {
  const now = Date.now();
  await env.DB
    .prepare(
      "UPDATE users SET created_at = COALESCE(created_at, ?), trial_ends_at = COALESCE(trial_ends_at, ?) WHERE id = ?"
    )
    .bind(now, now + TRIAL_MS, userId)
    .run();
}

// ---------- auth routes ----------

async function handleAuthRequest(env, request) {
  const body = await readJson(request);
  const email = body && typeof body.email === "string" ? body.email : "";
  if (!email) return json({ error: "invalid-email" }, 400);
  const cfg = makeCfg(env);
  const store = createD1Store(env.DB);
  const result = await requestMagicLink(store, cfg, {
    email,
    origin: new URL(request.url).origin,
    ip: requestIp(request),
  });
  switch (result) {
    case "ok":
      return json({ ok: true });
    case "invalid-email":
      return json({ error: "invalid-email" }, 400);
    case "rate-limited":
      return json({ error: "rate-limited" }, 429);
    case "not-configured":
      return json({ error: "not-configured" }, 500);
    default:
      return json({ error: "send-failed" }, 502);
  }
}

async function handleAuthVerify(env, request) {
  const body = await readJson(request);
  const email = body && typeof body.email === "string" ? body.email : "";
  const code = body && typeof body.code === "string" ? body.code : "";
  if (!email || !code) return json({ error: "invalid" }, 400);
  const cfg = makeCfg(env);
  const store = createD1Store(env.DB);
  const result = await verifyCode(store, cfg, { email, code, ip: requestIp(request) });
  if (!result.ok) {
    const status = result.result === "rate-limited" || result.result === "too-many-attempts" ? 429 : 401;
    return json({ error: result.result }, status);
  }
  await ensureTrial(env, result.user.id);
  return json({ ok: true, email: result.user.email }, 200, {
    "Set-Cookie": sessionCookie(result.sessionToken, cfg),
  });
}

async function handleAuthVerifyLink(env, request) {
  const body = await readJson(request);
  const token = body && typeof body.token === "string" ? body.token : "";
  if (!token) return json({ error: "invalid-token" }, 400);
  const cfg = makeCfg(env);
  const store = createD1Store(env.DB);
  const result = await verifyMagicToken(store, cfg, token);
  if (!result.ok) return json({ error: result.reason }, 401);
  await ensureTrial(env, result.user.id);
  return json({ ok: true, email: result.user.email }, 200, {
    "Set-Cookie": sessionCookie(result.sessionToken, cfg),
  });
}

async function handleAuthMe(env, request) {
  const user = await currentUser(env, request);
  if (!user) return json({ error: "unauthenticated" }, 401);
  return json({ email: user.email, trialEndsAt: user.trialEndsAt, plan: planOf(user, Date.now()) });
}

async function handleAuthLogout(env, request) {
  const cfg = makeCfg(env);
  const store = createD1Store(env.DB);
  const { clearCookie } = await destroySession(store, cfg, request);
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie });
}

// ---------- sync routes ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate + sanitize one wire record; returns null when malformed. */
function sanitizeRecord(rec) {
  if (!rec || typeof rec !== "object") return null;
  const id = rec.id;
  const updatedAt = rec.updatedAt;
  if (typeof id !== "string" || id.length < 1 || id.length > 100) return null;
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  if (rec.deleted === true) return { id, updatedAt, deleted: true };
  const { vendor, amount, currency, date, category, note, source, createdAt } = rec;
  if (typeof vendor !== "string" || vendor.length > 200) return null;
  if (!Number.isFinite(amount)) return null;
  if (typeof currency !== "string" || currency.length < 1 || currency.length > 8) return null;
  if (typeof date !== "string" || !DATE_RE.test(date)) return null;
  if (typeof category !== "string" || category.length > 40) return null;
  if (note != null && (typeof note !== "string" || note.length > 500)) return null;
  if (source != null && (typeof source !== "string" || source.length > 20)) return null;
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  return {
    id,
    vendor,
    amount,
    currency,
    date,
    category,
    note: note ?? "",
    source: source ?? "manual",
    createdAt,
    updatedAt,
    deleted: false,
  };
}

async function requireSyncUser(env, request) {
  const user = await currentUser(env, request);
  if (!user) return { error: json({ error: "unauthenticated" }, 401) };
  if (planOf(user, Date.now()) !== "trial") return { error: json({ error: "trial-ended" }, 403) };
  return { user };
}

async function handleSyncPull(env, request, url) {
  const { user, error } = await requireSyncUser(env, request);
  if (error) return error;
  const sinceRaw = Number(url.searchParams.get("since") || 0);
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
  const rows = await env.DB
    .prepare(
      "SELECT seq, record_id, payload, updated_at, deleted FROM spends WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"
    )
    .bind(user.id, since, SYNC_PULL_LIMIT)
    .all();
  const maxRow = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM spends").first();
  const records = (rows.results || []).map((r) => ({
    recordId: r.record_id,
    updatedAt: Number(r.updated_at),
    deleted: Number(r.deleted) === 1,
    data: JSON.parse(r.payload),
  }));
  return json({ records, cursor: maxRow ? Number(maxRow.s) : 0 });
}

async function handleSyncPush(env, request) {
  const { user, error } = await requireSyncUser(env, request);
  if (error) return error;
  const body = await readJson(request);
  if (!body || !Array.isArray(body.records)) return json({ error: "invalid-body" }, 400);
  if (body.records.length > SYNC_PUSH_LIMIT) return json({ error: "too-many-records" }, 413);
  let accepted = 0;
  let skipped = 0;
  const rejected = [];
  for (const raw of body.records) {
    const rec = sanitizeRecord(raw);
    if (!rec) {
      rejected.push(raw && typeof raw.id === "string" ? raw.id : null);
      continue;
    }
    const latest = await env.DB
      .prepare("SELECT updated_at FROM spends WHERE user_id = ? AND record_id = ? ORDER BY seq DESC LIMIT 1")
      .bind(user.id, rec.id)
      .first();
    if (latest && rec.updatedAt <= Number(latest.updated_at)) {
      skipped++; // stale or duplicate delivery — LWW keeps the newer version
      continue;
    }
    await env.DB
      .prepare("INSERT INTO spends (user_id, record_id, payload, updated_at, deleted) VALUES (?, ?, ?, ?, ?)")
      .bind(user.id, rec.id, JSON.stringify(rec), rec.updatedAt, rec.deleted ? 1 : 0)
      .run();
    accepted++;
  }
  const maxRow = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM spends").first();
  return json({ accepted, skipped, rejected, cursor: maxRow ? Number(maxRow.s) : 0 });
}

// ---------- router ----------

async function handleApi(env, request, url) {
  const path = url.pathname;
  const method = request.method;
  if (path === "/api/auth/request" && method === "POST") return handleAuthRequest(env, request);
  if (path === "/api/auth/verify" && method === "POST") return handleAuthVerify(env, request);
  if (path === "/api/auth/verify-link" && method === "POST") return handleAuthVerifyLink(env, request);
  if (path === "/api/auth/me" && method === "GET") return handleAuthMe(env, request);
  if (path === "/api/auth/logout" && method === "POST") return handleAuthLogout(env, request);
  if (path === "/api/sync" && method === "GET") return handleSyncPull(env, request, url);
  if (path === "/api/sync" && method === "PUT") return handleSyncPush(env, request);
  return json({ error: "not-found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(env, request, url);
      } catch {
        return json({ error: "server-error" }, 500);
      }
    }
    // Deployed as the standalone `onespends-api` Worker routed only on
    // /api/* (see ARCHITECTURE.md), so non-API paths never arrive here; if
    // one ever does, ASSETS exists only in a Pages context.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: "not-found" }, 404);
  },
};
