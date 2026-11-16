#!/usr/bin/env python3
"""Run SQL against the OneSpends D1 database via the cf-api credential route.

Usage:
  d1-sql.py "SELECT ..."            # one statement, prints JSON result rows
  d1-sql.py --file schema.sql       # run every statement in a file (split on ';')

Values are never printed except the query results you asked for.
"""
import json
import subprocess
import sys

CF_API = "/home/hatch/workspace/custom-skills/local-cloudflare/bin/cf-api"
ACCOUNT = "f1868a071996e836eae6da2b65f37929"
DB_ID = "40e08871-7b2b-4c07-a272-e9ac5b7e5e2b"  # onespends-db


def run_sql(sql, params=None):
    body = {"sql": sql}
    if params:
        body["params"] = params
    out = subprocess.run(
        [CF_API, "POST", f"/client/v4/accounts/{ACCOUNT}/d1/database/{DB_ID}/query", json.dumps(body)],
        capture_output=True, text=True, timeout=60,
    )
    try:
        d = json.loads(out.stdout)
    except Exception:
        print("cf-api bad output:", out.stdout[:300], out.stderr[:300], file=sys.stderr)
        sys.exit(1)
    if not d.get("success"):
        print("D1 error:", json.dumps(d.get("errors"))[:400], file=sys.stderr)
        sys.exit(1)
    return d["result"]


def main():
    args = sys.argv[1:]
    if args and args[0] == "--file":
        text = open(args[1]).read()
        # strip comment lines, then split into statements
        lines = [ln for ln in text.splitlines() if not ln.strip().startswith("--")]
        stmts = [s.strip() for s in "\n".join(lines).split(";") if s.strip()]
        for s in stmts:
            run_sql(s)
            print("OK:", s.splitlines()[0][:80])
    elif args:
        res = run_sql(args[0])
        for block in res:
            print(json.dumps(block.get("results", []), ensure_ascii=False))
            print("meta:", json.dumps(block.get("meta", {})))
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
