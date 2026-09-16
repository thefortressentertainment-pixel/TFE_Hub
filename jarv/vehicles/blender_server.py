#!/usr/bin/env python3
"""blender_server.py — the live bpy cockpit for the JARV vehicle system.

Run INSIDE Blender so JARV can drive the running app's own runtime instead of
fragile UI scripting:

    Blender --background --python jarv/vehicles/blender_server.py

That blocks the event loop, so pair it with --python-expr for a watchdog, or
run it in a Terminal window (it only prints one banner). Contract:

    request:  {"src": "<python, executes inside Blender>"}
    response: {"ok": "<repr(result)>"}        after exec of the src
              {"ok": "done"}                  if src never set `result`
              {"err": "<traceback>"}          if exec raised

The src text runs with sys.stdout redirected into a buffer, so print() output is
captured and echoed in `result` (or the trailing result variable is used).
Unix socket only — no network, no firewall prompts. `--life <pid>` makes the
server exit when that pid dies (the launcher that parked this blender).
"""
import json
import os
import socket
import sys
import threading
import traceback

SOCK = os.path.expanduser("~/.jarv/vehicles/blender.sock")


def _serve(conn):
    try:
        raw = conn.recv(1 << 20)
        if not raw:
            return
        try:
            src = json.loads(raw.decode())["src"]
        except Exception:
            conn.sendall(json.dumps({"err": "bad request"}).encode())
            return
        out = []
        buf = sys.stdout
        sys.stdout = sys.__stdout__
        try:
            g = {"bpy": __import__("bpy"), "__builtins__": __builtins__}
            sys.stdout.flush()
            exec(compile(src, "<jarv-bpy>", "exec"), g)
            result = g.get("result", out)
            conn.sendall(json.dumps({"ok": repr(result)[:8000]}).encode())
        except Exception:
            conn.sendall(json.dumps({"err": traceback.format_exc()[-8000:]}).encode())
        finally:
            pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def main():
    life = None
    if "--life" in sys.argv:
        try:
            life = int(sys.argv[sys.argv.index("--life") + 1])
        except (IndexError, ValueError):
            life = None
    os.makedirs(os.path.dirname(SOCK), exist_ok=True)
    try:
        os.unlink(SOCK)
    except OSError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK)
    srv.listen(4)
    print(f"[jarv] bpy cockpit on {SOCK} — (bpy: {__import__('bpy').app.version_string})")
    sys.stdout.flush()
    while True:
        if life is not None:
            try:
                os.kill(life, 0)
            except OSError:
                break
        srv.settimeout(1.0)
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        threading.Thread(target=_serve, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()