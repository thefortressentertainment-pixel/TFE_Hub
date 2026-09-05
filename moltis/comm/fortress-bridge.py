#!/usr/bin/env python3
"""Fortress bridge — lets Moltis agents command the hub Settlement API over HTTP.
Usage:
  fortress-bridge.py team
  fortress-bridge.py roi
  fortress-bridge.py health
  fortress-bridge.py talk <agent> <message>
  fortress-bridge.py dispatch <agent> <task>
Exit code 0 on success; prints JSON to stdout. Never fabricates output."""
import json
import sys
import urllib.request
import urllib.parse
import urllib.error

HUB = "http://127.0.0.1:4002"


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        HUB + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {"error": "http " + str(e.code)}
    except Exception as e:
        return 0, {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}


def main(argv):
    cmd = argv.pop(0) if argv else "roi"
    if cmd in ("team",):
        status, out = call("GET", "/api/settlement/team")
        json.dump(out, sys.stdout, indent=2); print()
    elif cmd in ("roi",):
        status, out = call("GET", "/api/settlement/roi")
        json.dump(out, sys.stdout, indent=2); print()
    elif cmd in ("health",):
        status, out = call("GET", "/health")
        json.dump(out, sys.stdout, indent=2); print()
    elif cmd in ("talk", "dispatch"):
        if len(argv) < 2:
            print(json.dumps({"ok": False, "error": "usage: bridge %s <agent> <text>" % cmd}))
            return 1
        agent, text = argv[0], " ".join(argv[1:])
        status, out = call("POST", "/api/settlement/" + cmd,
                           {"agent": agent, "message": text} if cmd == "talk" else {"agent": agent, "task": text})
        json.dump(out, sys.stdout, indent=2); print()
        return 0 if status < 400 and out.get("ok") else 1
    else:
        print(json.dumps({"ok": False, "error": "unknown command: %s" % cmd}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))