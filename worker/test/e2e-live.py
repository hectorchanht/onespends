#!/usr/bin/env python3
"""LIVE E2E for OneSpends auth + sync against onespends.dawnstudio.app.

Sends exactly ONE magic email (to Hector's own address), then completes
verification WITHOUT reading the inbox: the 6-digit code is recovered from
D1's code_hash (sha256('code:'+code)) by brute force over 000000-999999 —
test-only, against our own database. Ends by cleaning up every test row.
"""
import hashlib
import json
import subprocess
import sys
import time
import urllib.request
import urllib.error

BASE = "https://onespends.dawnstudio.app"
EMAIL = "f147259@gmail.com"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Content-Type": "application/json"}
D1 = "/home/hatch/workspace/onespends-worker/tools/d1-sql.py"


def http(method, path, body=None, cookie=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    for k, v in UA.items():
        req.add_header(k, v)
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.headers, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, e.headers, json.loads(raw or "{}")
        except Exception:
            return e.code, e.headers, {"raw": raw[:200]}


def d1(sql):
    out = subprocess.run(["python3", D1, sql], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        print("D1 failed:", out.stderr[:300]); sys.exit(1)
    lines = [ln for ln in out.stdout.splitlines() if ln.startswith("[")]
    return json.loads(lines[0]) if lines else []


step = 0
def ok(msg):
    global step
    step += 1
    print(f"  ✓ step {step}: {msg}")

# 1 — request the ONE magic email
status, _, body = http("POST", "/api/auth/request", {"email": EMAIL})
assert status == 200 and body.get("ok"), (status, body)
ok("POST /api/auth/request → 200 ok (Resend accepted the send)")

# 2 — recover the code from D1 (test-only)
rows = d1(f"SELECT code_hash FROM magic_tokens WHERE email = '{EMAIL}' AND used = 0 ORDER BY rowid DESC LIMIT 1")
assert rows, "no live magic token row in D1"
target = rows[0]["code_hash"]
code = None
for i in range(1000000):
    cand = f"{i:06d}"
    if hashlib.sha256(("code:" + cand).encode()).hexdigest() == target:
        code = cand
        break
assert code, "code not recovered"
ok("6-digit code recovered from D1 code_hash (inbox untouched)")

# 3 — verify → session cookie
status, headers, body = http("POST", "/api/auth/verify", {"email": EMAIL, "code": code})
assert status == 200 and body.get("ok"), (status, body)
set_cookie = headers.get("Set-Cookie", "")
assert "onespends_session=" in set_cookie and "HttpOnly" in set_cookie, set_cookie[:80]
cookie = set_cookie.split(";")[0]
ok("POST /api/auth/verify → 200 + httpOnly session cookie")

# 4 — /me shows the trial
status, _, me = http("GET", "/api/auth/me", cookie=cookie)
assert status == 200 and me["email"] == EMAIL and me["plan"] == "trial", (status, me)
days = (me["trialEndsAt"] - int(time.time() * 1000)) / 86400000
assert 89 < days <= 90, days
ok(f"GET /api/auth/me → trial, ends in {days:.1f} days")

now = int(time.time() * 1000)
def rec(rid, amount, updated):
    return {"id": rid, "vendor": "E2E TEST", "amount": amount, "currency": "CAD",
            "date": "2026-10-26", "category": "其他", "note": "e2e", "source": "manual",
            "createdAt": updated - 1000, "updatedAt": updated}

# 5 — device 1 pushes two records
status, _, put = http("PUT", "/api/sync", {"records": [rec("e2e-rec-1", 12.34, now), rec("e2e-rec-2", 56.78, now + 1)]}, cookie=cookie)
assert status == 200 and put["accepted"] == 2, (status, put)
ok("device 1: PUT /api/sync accepted 2 records")

# 6 — device 2 (fresh pull, since=0) sees both
status, _, pull = http("GET", "/api/sync?since=0", cookie=cookie)
ids = sorted(r["recordId"] for r in pull["records"])
assert ids == ["e2e-rec-1", "e2e-rec-2"], ids
cursor = pull["cursor"]
ok(f"device 2: GET /api/sync?since=0 → both records, cursor {cursor}")

# 7 — device 2 edits one, deletes the other
status, _, put = http("PUT", "/api/sync", {"records": [rec("e2e-rec-1", 99.99, now + 100000),
                                                       {"id": "e2e-rec-2", "updatedAt": now + 100001, "deleted": True}]}, cookie=cookie)
assert status == 200 and put["accepted"] == 2, (status, put)
ok("device 2: edit e2e-rec-1 (newer) + tombstone e2e-rec-2 accepted")

# 8 — device 1 pulls since cursor → edit + tombstone, LWW order intact
status, _, pull = http("GET", f"/api/sync?since={cursor}", cookie=cookie)
by_id = {r["recordId"]: r for r in pull["records"]}
assert by_id["e2e-rec-1"]["data"]["amount"] == 99.99, by_id
assert by_id["e2e-rec-2"]["deleted"] is True, by_id
ok("device 1: incremental pull shows the 99.99 edit + the tombstone")

# 9 — stale write is refused by LWW
status, _, put = http("PUT", "/api/sync", {"records": [rec("e2e-rec-1", 1.00, now)]}, cookie=cookie)
assert put["accepted"] == 0 and put["skipped"] == 1, put
ok("stale push skipped by last-write-wins")

# 10 — cleanup: tombstone the remaining test record via API, then purge rows
http("PUT", "/api/sync", {"records": [{"id": "e2e-rec-1", "updatedAt": now + 200000, "deleted": True}]}, cookie=cookie)
http("POST", "/api/auth/logout", cookie=cookie)
uid = d1(f"SELECT id FROM users WHERE email = '{EMAIL}'")[0]["id"]
d1(f"DELETE FROM spends WHERE user_id = '{uid}'")
d1(f"DELETE FROM sessions WHERE user_id = '{uid}'")
d1(f"DELETE FROM magic_tokens WHERE email = '{EMAIL}'")
d1(f"DELETE FROM users WHERE id = '{uid}'")
left = d1(f"SELECT (SELECT COUNT(*) FROM users WHERE email='{EMAIL}') + (SELECT COUNT(*) FROM spends WHERE user_id='{uid}') AS n")
assert left[0]["n"] == 0, left
ok("cleanup: test records tombstoned, session destroyed, all test rows purged from D1")

print(f"\ne2e-live.py: {step} steps passed")
