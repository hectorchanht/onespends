// Local E2E for the bundled _worker.js: real @dawn-studio/auth code + the
// OneSpends routes against a node:sqlite-backed fake D1, with the Resend API
// stubbed (the stub captures the outgoing email so the test can read the
// 6-digit code + magic token exactly as a user's inbox would deliver them).
import assert from "node:assert/strict";
import { makeFakeD1 } from "./fake-d1.mjs";

const worker = (await import("../dist/worker.js")).default;

const sentEmails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.resend.com/")) {
    sentEmails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "test-email-id" }), { status: 200 });
  }
  throw new Error("unexpected fetch: " + url);
};

const env = {
  DB: makeFakeD1(),
  RESEND_API_KEY: "re_test_key",
  ASSETS: { fetch: async () => new Response("STATIC-ASSET", { status: 200 }) },
};
const ORIGIN = "https://onespends.dawnstudio.app";
const call = (path, { method = "GET", body, cookie } = {}) =>
  worker.fetch(
    new Request(ORIGIN + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        "CF-Connecting-IP": "203.0.113.7",
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env
  );

let passed = 0;
const ok = (name) => { passed++; console.log("  ✓", name); };

// --- static passthrough -------------------------------------------------
{
  const res = await call("/app");
  assert.equal(await res.text(), "STATIC-ASSET");
  ok("non-/api passes through to ASSETS");
}

// --- /me unauthenticated --------------------------------------------------
{
  const res = await call("/api/auth/me");
  assert.equal(res.status, 401);
  ok("GET /api/auth/me without session → 401");
}

// --- request a magic email -------------------------------------------------
{
  const res = await call("/api/auth/request", { method: "POST", body: { email: "Test@Example.com" } });
  assert.equal(res.status, 200);
  assert.equal(sentEmails.length, 1);
  const mail = sentEmails[0];
  assert.equal(mail.from, "Dawn Studio <login@dawnstudio.app>");
  assert.equal(mail.to, "test@example.com");
  ok("POST /api/auth/request sends ONE email carrying code + link");
}
const mailText = sentEmails[0].text;
const code = mailText.match(/\b(\d{6})\b/)[1];
const token = mailText.match(/token=([0-9a-f]{64})/)[1];
assert.ok(code && token, "email carries a 6-digit code and a 64-hex token");

// --- wrong code: refused, attempt counted ---------------------------------
{
  const wrong = code === "000000" ? "111111" : "000000";
  const res = await call("/api/auth/verify", { method: "POST", body: { email: "test@example.com", code: wrong } });
  assert.equal(res.status, 401);
  ok("wrong code → 401");
}

// --- verify with the code → session cookie + trial stamped -----------------
let cookie;
{
  const res = await call("/api/auth/verify", { method: "POST", body: { email: "test@example.com", code } });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("Set-Cookie");
  assert.match(setCookie, /onespends_session=/);
  assert.match(setCookie, /HttpOnly/);
  cookie = setCookie.split(";")[0];
  const me = await (await call("/api/auth/me", { cookie })).json();
  assert.equal(me.email, "test@example.com");
  assert.equal(me.plan, "trial");
  const days = (me.trialEndsAt - Date.now()) / 86400000;
  assert.ok(days > 89 && days <= 90, "trial ≈ 90 days, got " + days);
  ok("code verify → session; /me shows trial with ~90 days left");
}

// --- the link credential died with the code (one intent, two credentials) --
{
  const res = await call("/api/auth/verify-link", { method: "POST", body: { token } });
  assert.equal(res.status, 401);
  ok("magic link is burned after the code was used");
}

// --- fresh intent: link path works -----------------------------------------
let cookie2;
{
  await call("/api/auth/request", { method: "POST", body: { email: "second@example.com" } });
  const m2 = sentEmails[1].text;
  const token2 = m2.match(/token=([0-9a-f]{64})/)[1];
  const res = await call("/api/auth/verify-link", { method: "POST", body: { token: token2 } });
  assert.equal(res.status, 200);
  cookie2 = res.headers.get("Set-Cookie").split(";")[0];
  const me = await (await call("/api/auth/me", { cookie: cookie2 })).json();
  assert.equal(me.email, "second@example.com");
  ok("magic-link verify → session for a second user");
}

// --- sync: push / pull / LWW / tombstone ------------------------------------
const rec = (id, amount, updatedAt) => ({
  id, vendor: "大家樂", amount, currency: "HKD", date: "2026-10-20",
  category: "餐飲", note: "", source: "manual", createdAt: updatedAt - 1000, updatedAt,
});
{
  const put = await (await call("/api/sync", { method: "PUT", cookie, body: { records: [rec("r1", 50, 100000), rec("r2", 30, 100001)] } })).json();
  assert.equal(put.accepted, 2);
  const pull = await (await call("/api/sync?since=0", { cookie })).json();
  assert.equal(pull.records.length, 2);
  assert.equal(pull.records[0].data.vendor, "大家樂");
  assert.ok(pull.cursor > 0);
  ok("push 2 records → pull returns both + cursor");
}
{
  // stale write loses; newer write wins
  const stale = await (await call("/api/sync", { method: "PUT", cookie, body: { records: [rec("r1", 999, 90000)] } })).json();
  assert.equal(stale.accepted, 0); assert.equal(stale.skipped, 1);
  const newer = await (await call("/api/sync", { method: "PUT", cookie, body: { records: [rec("r1", 55, 100500)] } })).json();
  assert.equal(newer.accepted, 1);
  const pull = await (await call("/api/sync?since=0", { cookie })).json();
  const latest = pull.records.filter((r) => r.recordId === "r1").pop();
  assert.equal(latest.data.amount, 55);
  ok("LWW: stale push skipped, newer push appended");
}
{
  // tombstone propagates; another user's pull sees nothing of mine
  const del = await (await call("/api/sync", { method: "PUT", cookie, body: { records: [{ id: "r2", updatedAt: 101000, deleted: true }] } })).json();
  assert.equal(del.accepted, 1);
  const pull = await (await call("/api/sync?since=0", { cookie })).json();
  const tomb = pull.records.filter((r) => r.recordId === "r2").pop();
  assert.equal(tomb.deleted, true);
  const other = await (await call("/api/sync?since=0", { cookie: cookie2 })).json();
  assert.equal(other.records.length, 0);
  ok("tombstone appended + per-user isolation");
}
{
  // malformed records are rejected, not stored
  const res = await call("/api/sync", { method: "PUT", cookie, body: { records: [{ id: "bad", updatedAt: 1, vendor: 5 }] } });
  const body = await res.json();
  assert.equal(body.rejected.length, 1);
  ok("malformed record rejected");
}

// --- trial gate: expired trial pauses sync, data untouched ------------------
{
  env.DB._raw.prepare("UPDATE users SET trial_ends_at = ? WHERE email = ?").run(Date.now() - 1000, "test@example.com");
  const me = await (await call("/api/auth/me", { cookie })).json();
  assert.equal(me.plan, "free");
  const pull = await call("/api/sync?since=0", { cookie });
  assert.equal(pull.status, 403);
  const put = await call("/api/sync", { method: "PUT", cookie, body: { records: [rec("r9", 1, 200000)] } });
  assert.equal(put.status, 403);
  ok("past trial: /me plan=free, sync GET+PUT → 403, nothing deleted");
}

// --- logout kills the session ----------------------------------------------
{
  const res = await call("/api/auth/logout", { method: "POST", cookie: cookie2 });
  assert.equal(res.status, 200);
  const me = await call("/api/auth/me", { cookie: cookie2 });
  assert.equal(me.status, 401);
  ok("logout → session destroyed");
}

globalThis.fetch = realFetch;
console.log(`\nworker.test.mjs: ${passed} checks passed`);
