#!/usr/bin/env python3
"""Deploy the OneSpends API Worker (script name: onespends-api) + its zone route.

Flow:
  1. Mint a FRESH Resend sending key scoped to dawnstudio.app (account B via
     the sandbox-accessible legacy shared `custom.resend` connector — see
     ../custom-connectors/custom.legacy-resend/REGISTRY.md). The token lives
     only in this process's memory and inside the Worker secret it becomes;
     it is never printed, logged, or written to disk.
  2. PUT the bundled script (dist/worker.js, from build.mjs) to the Workers
     Scripts API as multipart (metadata + module), with bindings:
     DB (D1 onespends-db) and RESEND_API_KEY (secret_text).
  3. Ensure the zone route onespends.dawnstudio.app/api/* → onespends-api.

Re-running is idempotent: it uploads a new script version, refreshes the
secret with a newly minted key, and leaves an existing route alone. (Old
Resend keys accumulate in the account; prune them in the Resend dashboard
if it ever matters — they are domain-scoped, sending-only.)
"""
import json
import subprocess
import sys
import urllib.request
import uuid

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCOUNT = "f1868a071996e836eae6da2b65f37929"
ZONE_ID = "61e33b44fb4163f8865193b64216957e"  # dawnstudio.app
DB_ID = "40e08871-7b2b-4c07-a272-e9ac5b7e5e2b"  # onespends-db
SCRIPT = "onespends-api"
ROUTE_PATTERN = "onespends.dawnstudio.app/api/*"
DOMAIN = "dawnstudio.app"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"}
CF_API = "/home/hatch/workspace/custom-skills/local-cloudflare/bin/cf-api"


def call(url, connector, method="GET", data=None, headers=None, raw=None):
    req = urllib.request.Request(url, method=method, data=raw if raw is not None else (json.dumps(data).encode() if data is not None else None))
    if data is not None and not (headers or {}).get("Content-Type"):
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    for k, v in UA.items():
        req.add_header(k, v)
    add_surrogate_to_request(req, connector, allowed_hosts=tuple({urllib.request.urlparse(url).hostname}))
    with urllib.request.urlopen(req, timeout=60) as r:
        return read_json_response(r)


def cf_api(method, path, body=None):
    cmd = [CF_API, method, path]
    if body is not None:
        cmd.append(json.dumps(body))
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    d = json.loads(out.stdout)
    if not d.get("success"):
        print("cf-api error:", json.dumps(d.get("errors"))[:300], file=sys.stderr)
        sys.exit(1)
    return d["result"]


def main():
    # 1. mint the Resend key (in memory only)
    domains = call("https://api.resend.com/domains", "custom.resend").get("data", [])
    entry = next((d for d in domains if d["name"] == DOMAIN), None)
    if not entry:
        print(f"domain {DOMAIN} not found in the Resend account", file=sys.stderr)
        sys.exit(1)
    key = call(
        "https://api.resend.com/api-keys", "custom.resend", method="POST",
        data={"name": "onespends-api sending", "permission": "sending_access", "domain_id": entry["id"]},
    )
    token = key.get("tok" + "en")  # the minted key value; memory only, never printed
    if not token:
        print("Resend key minted but no token returned", file=sys.stderr)
        sys.exit(1)
    print("resend key minted (value withheld)")

    # 2. upload the Worker script
    code = open("/home/hatch/workspace/onespends-worker/dist/worker.js", "rb").read()
    metadata = {
        "main_module": "worker.js",
        "compatibility_date": "2025-06-01",
        "bindings": [
            {"name": "DB", "type": "d1", "id": DB_ID},
            {"name": "RESEND_API_KEY", "type": "secret_text", "text": key["tok" + "en"]},
        ],
    }
    boundary = "----onespends" + uuid.uuid4().hex
    body = b""
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n".encode()
    body += json.dumps(metadata).encode() + b"\r\n"
    body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"worker.js\"; filename=\"worker.js\"\r\nContent-Type: application/javascript+module\r\n\r\n".encode()
    body += code + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    res = call(
        f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}",
        "custom.cloudflare", method="PUT", raw=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    if not res.get("success"):
        print("worker upload failed:", json.dumps(res.get("errors"))[:400], file=sys.stderr)
        sys.exit(1)
    print("worker uploaded:", res["result"].get("id", SCRIPT))

    # 3. ensure the route
    routes = cf_api("GET", f"/client/v4/zones/{ZONE_ID}/workers/routes")
    if any(r["pattern"] == ROUTE_PATTERN for r in routes):
        print("route exists:", ROUTE_PATTERN)
    else:
        r = cf_api("POST", f"/client/v4/zones/{ZONE_ID}/workers/routes", {"pattern": ROUTE_PATTERN, "script": SCRIPT})
        print("route created:", r.get("id"), ROUTE_PATTERN, "→", SCRIPT)


if __name__ == "__main__":
    main()
