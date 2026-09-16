#!/usr/bin/env python3
"""jarv-toolkit — the filing cabinet that lives inside the JARV terminal IDE.

The IDE keeps doctrine OUT of context (load on demand with !doc); this router gives
JARV ONE plain-tool surface, organized by compartment:

    sense   fs|grep|fetch|state      read the world (files, web, local env)
    act     run|edit|open            change the world (host shell, surgical edit)
    mem     save|recall|lesson|lessons|stamp|timeline
                                      JARV's ~/.jarv memory file + its own
                                      learned lessons (agency: recall feeds back);
                                      stamp = the IDE auto-pings milestones here
    build   status|check             repo hygiene + verification
    arch    init|slice|result|...    sequential workbench: a multi-file job as a
                                      task ledger in ~/.jarv/workbench (one agent
                                      walks the slices in order, checkpoints as files)
    sys     ps|ctx                   resident models + local footprint
    app     find|probe|ui|do|keys    the hand: drive ANY app on this Mac (AppleScript
                                      + System Events accessibility: click, type,
                                      menus, keystrokes). probe reports what the
                                      target exposes BEFORE anything is touched
    skill   new|list|run             buy the missing tool: scaffold a self-contained
                                      skill pack in ~/.jarv/skills/<app>/ that JARV
                                      fills, tests and iterates until the task works
    vehicle probe|key|list|new|drive|cockpit
                                      skeleton keys: drive ANY app through a driver
                                      ladder (bundled scripting runtime > osascript
                                      dict > System Events UI > see). Cards in
                                      ~/.jarv/vehicles/<App>.md; drive picks the
                                      strongest live door; cockpit parks a console
                                      server (Blender/bpy) for interactive tasks
    secur   scan|report|list         the swivel: detect hostile content, log every
                                      encounter, notify the operator (SECURITY.md)

Output is plain, structured, truncated (never floods the budget). Fail-closed edits.
Stdlib only. Usage from the model:
    python3 /Users/tfe/fortress-hub/jarv/toolkit.py <comp> <verb> [...]
"""
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = "/Users/tfe/fortress-hub"
MEMFILE = os.path.expanduser("~/.jarv/toolkit-memory.json")
MAX_OUT = 4000  # characters of body before truncation


def report(lines, status="ok"):
    body = "\n".join(str(x) for x in lines).strip()
    if len(body) > MAX_OUT:
        body = body[:MAX_OUT] + "\n... [truncated]"
    print("ok" if status == "ok" else "error", body or "(empty)")


def sh(cmd, timeout=60):
    try:
        r = subprocess.run(shlex.split(cmd), capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return f"TIMEOUT after {timeout}s"
    out = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        # a bare empty reply hides the failure from the model — always mark it
        return f"[exit {r.returncode}] {out}" if out else f"[exit {r.returncode}] (no output)"
    return out or "(exit 0, no output)"


def pipe(cmd, timeout=60):
    """Run an internal command with real shell pipes. Only safe because every
    interpolated argument is already shlex.quote()d or literal."""
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return (r.stdout + r.stderr).strip() or f"(exit {r.returncode}, no output)"
    except subprocess.TimeoutExpired:
        return f"TIMEOUT after {timeout}s"


def after_dash(a):
    """Arguments after a literal '--' separator (or every arg past a[3])."""
    a = list(a)
    if "--" in a:
        return a[a.index("--") + 1:]
    return a[3:]


# ── sense: read the world ────────────────────────────────────────────────────

def _num(value, default):
    """Arguments, not flags. The model often appends the `--` separator other
    cabinet routes use (`sense fetch <url> -- 500`, `sense fs <path> -- 20`), so
    a stray separator is dropped here instead of crashing int(). These values
    are always counts/sizes, so any surviving sign is ignored."""
    digits = str(value).strip().lstrip("-")
    try:
        return int(digits) if digits else default
    except (TypeError, ValueError):
        return default


def sense_fs(path, lines):
    lines = _num(lines, 100)
    if not os.path.exists(path):
        return report([f"not found: {path}"], status="error")
    if os.path.isdir(path):
        return report([pipe(f"ls -la {shlex.quote(path)} | head -{min(lines, 100)}")])
    with open(path, errors="replace") as fh:
        return report(["\n".join(fh.read().splitlines()[: max(1, min(lines, 500))])])


def sense_grep(pattern, path):
    return report([pipe(f"grep -nE {shlex.quote(pattern)} {shlex.quote(path)} 2>&1 | head -60")])


def sense_fetch(url, maxchars):
    url = (url or "").strip()
    if not url.lower().startswith(("http://", "https://", "file://")):
        return report([f"fetch refused: only http(s)/file URLs (got: {url[:120] or '(empty)'})"],
                      status="error")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "jarv-toolkit/1.0"})
        data = urllib.request.urlopen(req, timeout=20).read()
        try:
            txt = data.decode("utf-8", "replace")
        except Exception:
            txt = f"<binary/undecodable {len(data)} bytes>"
        return report([txt[: max(2000, _num(maxchars, 2000))]])
    except urllib.error.HTTPError as e:
        try:
            detail = e.read(500).decode("utf-8", "replace").strip()
        except Exception:
            detail = ""
        lines = [f"fetch failed: HTTP {e.code} from {url}"]
        if detail:
            lines.append(f"server says: {detail[:400]}")
        lines.append("the body usually names the exact bad parameter — fix the URL, don't retry it blind.")
        return report(lines, status="error")
    except Exception as e:
        return report([f"fetch failed: {e}"], status="error")


def sense_state():
    head = sh("git -C " + REPO + " log --oneline -1")
    op = "registered (trusted principal)" if os.path.isfile(OPERATOR_FILE) else "not registered (secur trust)"
    return report([f"os: darwin (Apple Silicon 8GB, ollama on 127.0.0.1:11434)", f"repo: {REPO}", f"head: {head}", f"operator: {op}", f"memory file: {MEMFILE}", f"workbench: {WORKBENCH}"])


# ── act: change the world ────────────────────────────────────────────────────

def act_run(cmd):
    if len(cmd) > 3000:
        return report(["command too long"], status="error")
    return report([sh(cmd)])


def act_edit(path, before, after):
    if not os.path.isfile(path):
        return report([f"not found: {path}"], status="error")
    with open(path, errors="replace") as fh:
        content = fh.read()
    n = content.count(before)
    if n != 1:
        return report(
            [f"REFUSED: anchor occurs {n} times (need exactly 1). give more surrounding context"],
            status="error",
        )
    with open(path, "w") as fh:
        fh.write(content.replace(before, after))
    return report([f"edited: {path}", f"- {before[:80]}", f"+ {after[:80]}"])


def act_open(path):
    if not os.path.exists(path):
        return report([f"not found: {path}"], status="error")
    return report([f"opening: {path}", sh(f"open {shlex.quote(path)}")])


# ── comm: retired with the settlement ──────────────────────────────────────────
# The moltis settlement (sub-agent dispatch) was retired: this 8GB M1 cannot run
# a big model fanning out many workers. Slices run sequentially in-context, tracked
# on disk via the workbench.


# ── mem: shared memory ───────────────────────────────────────────────────────

def mem_load():
    try:
        with open(MEMFILE) as fh:
            return json.load(fh)
    except Exception:
        return {}


def mem_save(key, value):
    os.makedirs(os.path.dirname(MEMFILE), exist_ok=True)
    d = mem_load()
    d[key] = value
    with open(MEMFILE, "w") as fh:
        json.dump(d, fh, indent=2)
    return report([f"saved {key} -> {len(value)} chars"])


def mem_recall(key):
    d = mem_load()
    if key == "all":
        return report([json.dumps(d, indent=2)[:MAX_OUT]])
    return report([d.get(key, f"(no entry {key!r})")])


def mem_note(topic, text):
    """Append a lesson the model actually learned: what it did, the outcome,
    what it would do differently next time in similar context. This is the
    storage side of agency — the lessons feed back on later turns."""
    d = mem_load()
    os.makedirs(os.path.dirname(MEMFILE), exist_ok=True)
    lessons = d.setdefault("lessons", [])
    lessons.append({
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "topic": topic,
        "lesson": " ".join(text.split())[:600],
    })
    d["lessons"] = lessons[-120:]  # keep the memory bounded
    with open(MEMFILE, "w") as fh:
        json.dump(d, fh, indent=2)
    return report([f"lesson recorded ({len(lessons)} total): {topic}"])


def mem_lessons(terms=""):
    """Relevance-ranked recall of the model's own accumulated lessons.
    A term matches the topic or the body; short/stop terms count for less.
    Returns the top few — enough to steer, never enough to flood context."""
    d = mem_load()
    lessons = d.get("lessons", [])
    if not lessons:
        return report(["(no lessons yet — after meaningful steps or a declined /ok, "
                       "record one with: !kit mem lesson <topic> -- <what you'd change>)"])
    words = [w.lower() for w in re.findall(r"[a-z0-9]{4,}", terms.lower())]
    stop = {"that", "with", "this", "have", "from", "they", "will",
            "what", "when", "where", "which", "there", "their", "them"}
    words = [w for w in words if w not in stop]
    scored = []
    for L in lessons:
        topic = L.get("topic", "").lower()
        hay = topic + " " + L.get("lesson", "").lower()
        score = sum((2 if w in topic else 1) for w in words if w in hay)
        if not words:
            score = 1  # bare recall: newest first
        scored.append((score, L))
    scored.sort(key=lambda x: (-x[0], x[1].get("at", "")))
    keep = scored if not words else [x for x in scored if x[0] > 0]
    top = keep[:3]
    out = []
    for score, L in top:
        out.append(f"- [{L.get('at','')}] {L.get('topic','')}: {L.get('lesson','')}")
    if not out:
        return report([f"(no lessons matching '{terms}')"])
    return report(out)


def mem_stamp(event):
    """Milestone stamp, auto-pinged by the IDE (not by the model remembering to).
    The harness records what actually happened — a tool acted, a step was
    declined, an approved run executed — so JARV accretes a timeline the same
    way a good architect does: event → observe → recall → act differently.
    Dedupes consecutive repeats; timeline is bounded."""
    line = " ".join(event.split())[:400]
    if not line:
        return report(["(empty stamp — nothing written)"], status="error")
    d = mem_load()
    os.makedirs(os.path.dirname(MEMFILE), exist_ok=True)
    tl = d.setdefault("timeline", [])
    if tl and tl[-1]["e"] == line:
        return report(["(repeated milestone — not stamped again)"])
    tl.append({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "e": line})
    d["timeline"] = tl[-150:]
    with open(MEMFILE, "w") as fh:
        json.dump(d, fh, indent=2)
    return report([f"📝 stamped#{len(d['timeline'])}: {line}"])


def mem_timeline(n="5"):
    """The recent milestone timeline (what the harness recently watched happen)."""
    d = mem_load()
    tl = d.get("timeline", [])
    if not tl:
        return report(["(no milestones yet — they get auto-stamped as JARV acts)"])
    try:
        k = max(1, min(int(n), 50))
    except ValueError:
        k = 5
    return report([f"{t['at']} {t['e']}" for t in tl[-k:]])


# ── build: repo verification ─────────────────────────────────────────────────

def build_status():
    return report([sh(f"git -C {REPO} status --short"), "---", sh(f"git -C {REPO} branch --show-current")])


def build_check(what):
    if what == "backend":
        return report([pipe(f"cd {REPO}/backend && for f in src/*.js; do node --check \"$f\" || exit 1; done && npm run smoke 2>&1", timeout=180)])
    if what == "frontend":
        return report([pipe(f"cd {REPO}/frontend && npm run build 2>&1", timeout=300)])
    if what.endswith(".py"):
        return report([sh(f"{sys.executable} -m py_compile {shlex.quote(what)}")])
    return report([sh(f"node --check {shlex.quote(what)}")])


# ── sys ──────────────────────────────────────────────────────────────────────

def sys_ps():
    return report([sh("ollama ps")])


def sys_ctx():
    lines = []
    for p in (os.path.expanduser("~/.jarv"), MEMFILE):
        if os.path.isdir(p):
            size = sum(
                os.path.getsize(os.path.join(r, f))
                for r, _, fs in os.walk(p) for f in fs
            )
        elif os.path.isfile(p):
            size = os.path.getsize(p)
        else:
            size = 0
        lines.append(f"{p}: {size/1024:.0f} kB")
    lines.append(f"workbench items: {sum(1 for e in os.listdir(WORKBENCH) if os.path.isdir(os.path.join(WORKBENCH, e))) if os.path.isdir(WORKBENCH) else 0}")
    return report(lines)


def sys_self():
    """Self-audit of the running framework, for the operator asking what JARV
    would change about itself. Reads the real files under jarv/ and reports the
    concrete surface (sizes, sessions, lessons, incidents, vault, operator)."""
    jarv = os.path.dirname(os.path.abspath(__file__))
    lines = [f"framework root: {jarv}"]
    for f in sorted(os.listdir(jarv)):
        p = os.path.join(jarv, f)
        if os.path.isfile(p):
            lines.append(f"  {f:>12} {os.path.getsize(p):>8} B")
    mem = os.path.expanduser("~/.jarv/toolkit-memory.json")
    lessons = 0
    if os.path.isfile(mem):
        try:
            lessons = len(json.load(open(mem)).get("lessons", []))
        except Exception:
            pass
    lines.append(f"lessons on disk: {lessons}")
    incs = len(os.listdir(os.path.expanduser("~/.jarv/incidents"))) if os.path.isdir(os.path.expanduser("~/.jarv/incidents")) else 0
    lines.append(f"incidents on disk: {incs}")
    sess = len(os.listdir(os.path.expanduser("~/.jarv/sessions"))) if os.path.isdir(os.path.expanduser("~/.jarv/sessions")) else 0
    lines.append(f"sessions on disk: {sess}")
    lines.append(f"vault file: {'present' if os.path.isfile(os.path.expanduser('~/.jarv/vault/vault.jarv.vault')) or os.path.isfile(os.path.expanduser('~/.jarv/vault/jarv.vault')) else 'absent'}")
    lines.append(f"operator: {os.path.isfile(os.path.expanduser('~/.jarv/operator.json'))}")
    lines.append("pillars to audit in the source: hard gate / token · /ok loop · budget & window · viral-memory recall · web-fetch protocol · launcher")
    return report(lines)


# ── arch: the single-agent workbench (sequential ledger) ──────────────────────
# The settlement is retired; one agent walks a project as a FILE ledger so its
# context stays lean and checkpoints survive:
#   ~/.jarv/workbench/<id>-<slug>/plan.md          the plan + TODO slices
#   ~/.jarv/workbench/<id>-<slug>/results/<n>.md   each slice's DONE/BLOCKED
#   ~/.jarv/workbench/<id>-<slug>/report.md        merged verdict after verify
# The agent opens the plan, marks slice DONE as it goes, then collect+close.

WORKBENCH = os.path.expanduser("~/.jarv/workbench")


def _wb_next_id():
    os.makedirs(WORKBENCH, exist_ok=True)
    n = sum(1 for e in os.listdir(WORKBENCH) if os.path.isdir(os.path.join(WORKBENCH, e)))
    return f"{n + 1:04d}"


def _wb_slug(title):
    s = re.sub(r"[^a-zA-Z0-9 -]", "", title).strip().replace(" ", "-").lower()
    return s[:24] or "project"


def arch_init(title):
    tid = f"{_wb_next_id()}-{_wb_slug(title)}"
    base = os.path.join(WORKBENCH, tid)
    os.makedirs(os.path.join(base, "results"), exist_ok=True)
    with open(os.path.join(base, "plan.md"), "w") as fh:
        fh.write(f"# {tid} — {title}\n\n## Goal\n(what the finished, verified deliverable looks like)\n\n## Verification\n(how we prove it's correct)\n\n## Slices\n\n")
    return report([f"workbench: {base}"])


def arch_slice(tid, summary, contract):
    base = os.path.join(WORKBENCH, tid)
    plan = os.path.join(base, "plan.md")
    if not os.path.exists(plan):
        return report([f"no workbench {tid} (run `arch init`)"], status="error")
    n = 1 + max((int(m) for m in re.findall(r"SLICE-(\d+)", open(plan).read())), default=0)
    with open(plan, "a") as fh:
        fh.write(f"- [ ] SLICE-{n:02d} — {summary}\n    contract → results/{n:02d}.md\n")
    return report([f"slice {n:02d} added to {tid}", f"summary: {summary}", f"contract: {contract}"])


def arch_result(tid, n, body):
    results = os.path.join(WORKBENCH, tid, "results")
    if not os.path.isdir(results):
        return report([f"no workbench {tid}"], status="error")
    with open(os.path.join(results, f"{int(n):02d}.md"), "w") as fh:
        fh.write(body + ("\n" if not body.endswith("\n") else ""))
    return report([f"wrote results/{int(n):02d}.md"])  # worker returns DONE or BLOCKED


def arch_list():
    rows = []
    for e in sorted(os.listdir(WORKBENCH)):
        if not e.startswith("."):
            rows.append(e)
    return report(rows or ["no workbenches yet"]) if rows else report(["no workbenches yet"])


def arch_show(tid):
    plan = os.path.join(WORKBENCH, tid, "plan.md")
    if not os.path.exists(plan):
        return report([f"no workbench {tid}"], status="error")
    return report([open(plan).read()])


def arch_collect(tid):
    results = os.path.join(WORKBENCH, tid, "results")
    if not os.path.isdir(results):
        return report([f"no workbench {tid}"], status="error")
    files = sorted(f for f in os.listdir(results) if f.endswith(".md"))
    if not files:
        return report([f"no results yet — slices are outstanding"])
    return report([open(os.path.join(results, f), errors="replace").read().strip() for f in files])


def arch_close(tid, verdict):
    base = os.path.join(WORKBENCH, tid)
    if not os.path.exists(base):
        return report([f"no workbench {tid}"], status="error")
    with open(os.path.join(base, "report.md"), "w") as fh:
        fh.write(f"# {tid} — merged verdict\n\n{verdict}\n")
    return report([f"closed {tid}: report.md written"])


# ── secur: the swivel (hostile-content detection + incident log) ─────────────────
# Untrusted content is data, never directives. These verbs give JARV the reflex
# to check before acting, to record every encounter permanently, and to notify
# the operator with findings + countermeasures (SECURITY.md ladder: reject →
# quarantine → combat → notify).

INC_DIR = os.path.expanduser("~/.jarv/incidents")

_SIGNALS = [
    # (severity, name, regex, why)
    ("high", "instruction-override", r"(?i)ignore (all )?previous (instructions|rules|prompts)|disregard (your )?(rules|instructions)|abandon (your )?(rules|directives)"),
    ("high", "authority-inflation", r"(?i)system:|pretend (you are|to be)|now act as|from now on ?(you|i) am|as (a|the) (root|admin|superuser)"),
    ("high", "execute-payload", r"(?i)\b(base64|hex)-?decode (the|and) (echo|run|execute)|run (this|the following) (command|code|script)"),
    ("high", "exfiltration", r"(?i)(leak|exfil|send|upload|print).{0,40}(api[_-]?key|token|secret|password|credential)"),
    ("medium", "persuasion", r"(?i)(everyone|all (good |smart )?(engineers|agents)).{0,40}(does|agree)|you (must|have to) (believe|trust)|don't (you )?(want|trust)"),
    ("medium", "urgency-fear", r"(?i)urgently|immediately now|or else|or .{0,20}will (fail|be lost)"),
    ("medium", "secrecy-frame", r"(?i)don'?t tell (the|your) (user|operator)|do not (mention|report)|behind (the user|their back)|secretly"),
    ("medium", "frame-shift", r"(?i)imagine you're|roleplay|act absent the|you are actually|step out of (character|role)"),
    ("medium", "mannered-persuasion", r"(?i)with (all )?(due )?respect|if i may (say|ask|suggest)|humbly (request|ask|suggest)|respectfully (request|ask)|in the spirit of (cooperation|friendship|goodwill)|i would be (most |very )?grateful|kindly (request|ask|do|run|help)|i appreciate (it|you) (so|very) much"),
    ("medium", "friendly-persuasion", r"(?i)(be|what) a (dear|good (friend|fellow|chap|pal)|lamb)|my (dear )?friend|good (fellow|chap|man)|surely you (can|will|understand)|trust me,? (just|it'?s)|we'?re (friends|family|allies)|as a favor|do me a favor|just this once|nobody (will|would) (know|notice)|between (us|friends)|you can (do|help) me,? (right|yeah|c'?mon)?"),
    ("medium", "warm-flattery", r"(?i)you'?re (the )?(best|smartest|most (capable|helpful|reliable)) (agent|assistant|engineer|ai|one)|so (helpful|capable|reliable|good)|you always (know|do the right thing|help)|such a good (agent|assistant|engineer)|(as|like) a (trusted|valued) (friend|colleague|ally)"),
]


def _scan_text(text):
    hits = []
    for sev, name, pat in _SIGNALS:
        if re.search(pat, text):
            hits.append(f"[{sev}] {name} — matched hostile pattern")
    long_blob = re.findall(r"[A-Za-z0-9+/]{60,}={0,2}", text)
    if long_blob and ("decode" in text.lower() or "base64" in text.lower()):
        hits.append(f"[high] encoded-blob — {len(long_blob)} long base64-looking segments paired with decoding verbs")
    elif long_blob:
        hits.append(f"[medium] encoded-blob — {len(long_blob)} long opaque segments (suspect unless explained)")
    return hits


# ── vehicle: skeleton keys ───────────────────────────────────────────────────
# One small cabinet: every app gets a DRIVER LADDER — bundled scripting runtime
# (console: Blender/bpy, Maya/mel, Node, VBA …) is the strongest key, then a
# real AppleScript dictionary (osascript), then System Events UI, then `see`
# (OCR eyes + synthetic clicks). A vehicle card is a tiny markdown file under
# ~/.jarv/vehicles/<App>.md (pristine starters ship in jarv/vehicles/ and seed on
# first use). `probe` reads the doors, `key` shows the card, `drive` picks the
# strongest live door, `cockpit` parks a console server when the app has one.
# Skills stay as-is: a vehicle is the generic key, a skill packs a task.

VEHICLES_DIR = os.path.expanduser("~/.jarv/vehicles")
_VEH_SEED = os.path.join(REPO, "jarv", "vehicles")


def _seed_vehicles():
    if not os.path.isdir(VEHICLES_DIR):
        try:
            os.makedirs(VEHICLES_DIR, exist_ok=True)
        except OSError:
            return
    if os.path.isdir(_VEH_SEED):
        for f in os.listdir(_VEH_SEED):
            if not f.endswith(".md") or f.startswith("."):
                continue
            s = os.path.join(_VEH_SEED, f)
            d = os.path.join(VEHICLES_DIR, f)
            if not os.path.isfile(d) and os.path.isfile(s):
                with open(s) as fh:
                    with open(d, "w") as gh:
                        gh.write(fh.read())


def _vehicle_card(app):
    if not os.path.isdir(VEHICLES_DIR):
        return None, None
    want = app.rstrip("/").lower()
    for f in os.listdir(VEHICLES_DIR):
        if f.endswith(".md") and f[:-3].lower() == want:
            p = os.path.join(VEHICLES_DIR, f)
            with open(p) as fh:
                return p, fh.read()
    return None, None


def _card_meta(text):
    meta = {}
    for k in ("driver", "binary"):
        m = re.search(rf"^- {k}:\s*(.*)$", text, re.M)
        if m:
            meta[k] = m.group(1).strip().split("#", 1)[0].strip()
    return meta


def _bpy_socket():
    return os.path.join(VEHICLES_DIR, "blender.sock")


def _bpy_live():
    s = _bpy_socket()
    if not os.path.exists(s):
        return False
    try:
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.settimeout(2)
        c.connect(s)
        c.close()
        return True
    except OSError:
        return False


def _bpy_task(src):
    if not _bpy_live():
        return None, "no live cockpit — park one first: `vehicle cockpit <App>`"
    try:
        c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        c.settimeout(30)
        c.connect(_bpy_socket())
        c.sendall(json.dumps({"src": src}).encode())
        c.shutdown(socket.SHUT_WR)
        data = b""
        while True:
            chunk = c.recv(8192)
            if not chunk:
                break
            data += chunk
        c.close()
        return json.loads(data.decode()), None
    except Exception as exc:
        return None, f"cockpit error: {exc} — is the app still running?"


def vehicle_list():
    _seed_vehicles()
    if not os.path.isdir(VEHICLES_DIR):
        return report(["(no vehicles parked — cut a key: !kit vehicle new <App> -- <what it is>)"])
    rows = []
    for f in sorted(os.listdir(VEHICLES_DIR)):
        if not f.endswith(".md") or f.startswith("."):
            continue
        p = os.path.join(VEHICLES_DIR, f)
        with open(p) as fh:
            meta = _card_meta(fh.read())
        door = meta.get("driver", "ladder")
        if door == "console":
            door += " [cockpit " + ("live]" if _bpy_live() else "parked]")
        rows.append(f"{f[:-3]:<14} door: {door:<22} ({os.path.getsize(p)} B)")
    rows.append("cut new keys: !kit vehicle new <App> -- <what it is>")
    return report(rows)


def vehicle_probe(name):
    _seed_vehicles()
    real, miss = app_target(name)
    if real is None:
        return report(miss, status="error")
    lines = [f"{real}: vehicle card "]
    cardp, card = _vehicle_card(real)
    if cardp:
        meta = _card_meta(card)
        lines.append(f"  card: {cardp}  door: {meta.get('driver', 'ladder')}")
    else:
        lines.append("  card: none — cut one: !kit vehicle new " + real + " -- <what it is>")
    if "binary:" in card:
        binary = _card_meta(card).get("binary")
        lines.append(f"  console binary: {binary}  ({'present' if binary and os.path.isfile(binary) else 'MISSING'})")
        if _bpy_live():
            lines.append("  cockpit socket: live (" + _bpy_socket() + ")")
        else:
            lines.append("  cockpit socket: idle — park one: !kit vehicle cockpit " + real)
    lines.append("  ladder always available: System Events UI (`app probe`/`app ui`) + see (OCR clicks).")
    lines.append("probe the AppleScript/UI doors too: !kit app probe " + real)
    return report(lines)


def vehicle_key(name):
    _seed_vehicles()
    cardp, card = _vehicle_card(name)
    if not cardp:
        return report([f"no vehicle card for {name!r} — cut one: !kit vehicle new {name} -- <what it is>"],
                      status="error")
    return report([f"key: {cardp}", card[:1500]])


def vehicle_drive(app, src):
    if not (src or "").strip():
        return report([f"usage: vehicle drive {app} -- <driver src>  (ladder: console > osascript > ui > see)"],
                      status="error")
    _seed_vehicles()
    cardp, card = _vehicle_card(app)
    meta = _card_meta(card) if card else {}
    driver = meta.get("driver", "ladder")
    if driver == "console":
        if _bpy_live():
            data, err = _bpy_task(src)
            if err:
                return report([err], status="error")
            return report([f"cockpit reply ({app}):", json.dumps(data)[:MAX_OUT]])
        binary = meta.get("binary")
        if binary and os.path.isfile(binary):
            wrapped = src
            if re.search(r"\bresult\s*=", src):
                wrapped += "\nprint('RESULT: ' + repr(result))"
            return report([sh(f"{shlex.quote(binary)} --background --factory-startup --python-expr {shlex.quote(wrapped)}", timeout=180)])
        return report([f"card says console but the 'binary:' line is missing or not a real path — fix {cardp}"],
                      status="error")
    if driver == "osascript":
        return app_do(app, src)
    return report([f"{app} has no scriptable door (card driver: {driver}) — use the ladder:",
                   f"  !kit app probe {app}    !kit app ui {app}",
                   f"  !kit see screen | see app {app} | see text <label> | see click <x> <y>",
                   "or cut the card as console if it bundles a scripting runtime:",
                   f"  !kit vehicle new {app} -- <what it is>"], status="error")


def vehicle_cockpit(app):
    _seed_vehicles()
    cardp, card = _vehicle_card(app)
    meta = _card_meta(card) if card else {}
    binary = meta.get("binary")
    if not card or meta.get("driver") != "console" or not (binary and os.path.isfile(binary)):
        return report([f"{app} has no console cockpit door (needs a console vehicle card with a live 'binary:')"],
                      status="error")
    if _bpy_live():
        return report([f"cockpit already live on {_bpy_socket()}"])
    server = os.path.join(_VEH_SEED, "blender_server.py")
    log = os.path.expanduser("~/.jarv/cockpit.log")
    os.makedirs(VEHICLES_DIR, exist_ok=True)
    subprocess.Popen([binary, "--background", "--factory-startup", "--python", server],
                     stdout=open(log, "a"), stderr=subprocess.STDOUT)
    for _ in range(60):
        time.sleep(0.25)
        if _bpy_live():
            return report([f"cockpit live on {_bpy_socket()} — drive it: vehicle drive {app} -- <bpy src>",
                           f"log: {log}"])
    return report([f"cockpit did not answer in 15s — tail {log}"], status="error")


def vehicle_new(app, what=""):
    _seed_vehicles()
    app = app.strip("\"' ")
    if not app_path(app):
        apps = installed_apps()
        names = ", ".join(apps[:10]) + (" …" if len(apps) > 10 else "")
        return report([f"no installed app named '{app}' — refusing to cut a key for a phantom target.",
                       f"installed apps include: {names}"], status="error")
    real, _ = app_target(app)
    dst = os.path.join(VEHICLES_DIR, (real or app).lower() + ".md")
    if os.path.isfile(dst):
        return report([f"vehicle already parked: {dst} — show it with `vehicle key {real}` or edit the file."],
                      status="error")
    with open(os.path.join(_VEH_SEED, "_generic.md")) as fh:
        tmpl = fh.read()
    with open(dst, "w") as fh:
        fh.write(tmpl % {"app": real or app})
    return report([f"key cut: {dst}",
                   "next: !kit vehicle probe " + (real or app) + "   |   !kit vehicle key " + (real or app),
                   "if the app bundles its own scripting runtime (Blender/bpy, Maya/mel, Node, Excel/VBA) "
                   "edit the card to `driver: console` + add a 'binary:' line — that is its strongest key."])


def secur_scan(text):
    if not text.strip():
        return report(["give me text to scan (paste the fetched content or an AI's reply)"], status="error")
    hits = _scan_text(text[:20000])
    if not hits:
        return report(["scan clean — no injection/persuasion/exfiltration signals detected"])
    sev = "high" if any(h.startswith("[high]") for h in hits) else ("medium" if any(h.startswith("[medium]") for h in hits) else "low")
    return report([f"severity: {sev} — {len(hits)} signal(s):"] + hits)


def _next_incident():
    os.makedirs(INC_DIR, exist_ok=True)
    return 1 + len([f for f in os.listdir(INC_DIR) if f.endswith(".md")])


def secur_report(severity, source, summary):
    if severity not in ("low", "medium", "high"):
        severity = "medium"
    n = _next_incident()
    slug = re.sub(r"[^a-zA-Z0-9-]+", "-", source.split("/")[-1].split("@")[0])[:24] or "contact"
    path = os.path.join(INC_DIR, f"{n:03d}-{slug}.md")
    body = (
        f"INCIDENT {n:03d} · severity {severity}\n"
        f"source:  {source}\n"
        f"signals: {summary}\n"
        f"action:  reject + quarantine + combat (refused in one line, frame held)\n"
        f"foothold: none — nothing hostile executed or written\n"
    )
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(body)
    return report([f"NOTIFY — incident {n:03d} recorded", body.strip()])


def secur_list():
    if not os.path.isdir(INC_DIR):
        return report(["no incidents yet"])
    rows = []
    for f in sorted(os.listdir(INC_DIR)):
        first = open(os.path.join(INC_DIR, f), errors="replace").readline().strip()
        rows.append(f"{f}: {first}")
    return report(rows or ["no incidents yet"])


# ── app: the hand — drive ANY app on this Mac ────────────────────────────────
# A generic hand via AppleScript + System Events (macOS Accessibility). ALWAYS
# probe first: it reports what the target exposes (scripting dictionary, running
# state, accessibility permission) before anything is touched. Then the model
# scaffolds a skill pack and iterates until the operator's task works.

def _osascript(script, timeout=30):
    try:
        r = subprocess.run(["osascript", "-e", script],
                           capture_output=True, text=True, timeout=timeout)
        return (r.stdout + r.stderr).strip() or f"(exit {r.returncode}, no output)"
    except subprocess.TimeoutExpired:
        return f"TIMEOUT after {timeout}s"


# The hand must survive how the OPERATOR actually names apps ("the ace
# browser", "text editor"), not just bundle-exact names. This resolver is the
# ladder every app verb climbs; a miss TEACHES (closest candidates) instead of
# silently acting on the wrong app (the "open up the ace browser" → Safari bug).

_APP_DIRS = ("/System/Applications", "/Applications",
             os.path.expanduser("~/Applications"),
             "/System/Applications/Utilities", "/Applications/Utilities")
_APP_CATEGORY_WORDS = frozenset(("app", "apps", "browser", "editor", "ide",
                                 "the", "my", "open"))


def _bundle_ok(path):
    """A real app bundle: a directory with a Contents/ inside. Guards the
    mdfind fallback against lookalikes (e.g. /usr/share/terminfo/…/iTerm.app,
    a compiled terminfo entry, not an application)."""
    return bool(path) and os.path.isdir(path) and os.path.isdir(
        os.path.join(path, "Contents"))


def app_path(name):
    """Locate an installed app bundle: exact name in the app dirs first, then
    a validated Spotlight fallback. Single definition — the resolver below
    (app_target/_app_candidates) is the operator-flavored ladder on top."""
    for base in _APP_DIRS:
        for suffix in ("", ".app"):
            p = os.path.join(base, name.rstrip("/") + suffix)
            if os.path.isdir(p):
                return p
    hit = pipe(f"mdfind -name {shlex.quote(name)} 2>/dev/null | head -30", timeout=20)
    if not hit or hit.startswith(("Unknown option", "Usage:", "TIMEOUT", "(exit")):
        return None
    lines = [l for l in hit.splitlines() if l.endswith(".app")]
    apps = tuple(b.rstrip("/") + "/" for b in _APP_DIRS[:3])
    lines.sort(key=lambda l: 0 if l.startswith(apps) else 1)  # app dirs first
    for l in lines:
        if _bundle_ok(l):
            return l
    return None


def installed_apps():
    """Names of the app bundles actually on this Mac (name without .app)."""
    names = set()
    for base in _APP_DIRS:
        try:
            for e in os.listdir(base):
                if e.endswith(".app") and not e.startswith("."):
                    names.add(e[:-4])
        except OSError:
            pass
    return sorted(names)


def _case_rank(name):
    """0 for the properly-cased bundle, 1 for a stray lowercase twin. App
    bundles on macOS are Title Case, so a same-name lowercase sibling (a half
    finished copy of an installer) should always lose the tie."""
    return 0 if any(c.isupper() for c in name) else 1


def _app_candidates(q):
    """Installed-app matches for a free-text name, best first. Scoring:
    exact token == app word beats prefix match; shorter name breaks ties
    ('Ace' wins over 'Ace something'); on a full tie the Title Case bundle
    wins over a stray lowercase duplicate."""
    lc = q.strip().lower()
    installed = installed_apps()
    lower = {}
    for a in installed:                               # case-insensitive full
        k = a.lower()
        if k not in lower or _case_rank(a) < _case_rank(lower[k]):
            lower[k] = a
    if lc in lower:
        return [lower[lc]]
    tokens = [t for t in re.findall(r"[a-z0-9]+", lc)
              if t not in _APP_CATEGORY_WORDS]
    if not tokens:
        tokens = [lc]
    scored = []
    for a in installed:
        words = set(re.findall(r"[a-z0-9]+", a.lower()))
        s = sum(2 if t in words
                else 1 if any(w.startswith(t) or t.startswith(w) for w in words)
                else 0
                for t in tokens)
        if s:
            scored.append((s, -len(a), -_case_rank(a), a))
    scored.sort(reverse=True)
    return [a for _, _, _, a in scored]


def _canonical_app_name(q):
    """The on-disk stem with its real case, for an exact (case-insensitive)
    bundle hit — so `terminal` resolves to `Terminal`, not the typed case."""
    ql = q.strip().lower()
    for base in _APP_DIRS:
        try:
            for e in os.listdir(base):
                if e.endswith(".app") and e[:-4].lower() == ql:
                    return e[:-4]
        except OSError:
            continue
    return None


def app_target(name):
    """Resolve an operator-flavored app name to the installed bundle name.
    Returns (real_name, []) on a hit, or (None, miss_lines) that teach: what
    was tried and the nearest real candidates."""
    q = (name or "").strip()
    if not q:
        return None, ["no app name given — usage: app find|probe|ui <name>"]
    p = app_path(q)                                   # exact bundle hit
    if p:
        canon = _canonical_app_name(q)
        if not canon and p.endswith(".app"):
            canon = os.path.basename(p[:-4])          # stem of the real bundle
        return canon or q, []
    cands = _app_candidates(q)
    if cands:
        return cands[0], []
    installed = installed_apps()
    lc = q.lower()
    fuzzy = [a for a in installed
             if lc in a.lower() or any(t and t in a.lower() for t in lc.split())]
    miss = [f"no installed app matches {q!r} "
            "(tried exact name, case-insensitive, word match, Spotlight)"]
    if fuzzy:
        miss.append("did you mean: " + ", ".join(fuzzy[:6]))
    miss.append("next: !kit app find <closer name> — or `!exec ls /Applications` "
                "for the real bundle names")
    return None, miss


def app_find_verb(name):
    """Resolve an app name BEFORE acting: the resolved bundle + the runners-up,
    so a wrong pick is visible instead of silent."""
    q = (name or "").strip()
    if not q:
        return report(["usage: app find <name> — e.g. app find ace browser"],
                      status="error")
    real, miss = app_target(q)
    if real is None:
        return report(miss, status="error")
    path = app_path(real)
    lines = [f"{q!r} → {real}" + (f"   ({path})" if path else "")]
    rest = [a for a in _app_candidates(q) if a != real][:5]
    if rest:
        lines.append("other matches: " + ", ".join(rest))
    lines.append(f"next: !kit app probe {real}  (recon before driving it)")
    return report(lines)


def app_probe(name):
    """Read-only recon on an app BEFORE touching it: what the name resolved
    to, bundle location, scripting dictionary, accessibility, running state."""
    lines = []
    real, miss = app_target(name)
    status = "ok"
    if real is None:
        return report(miss, status="error")
    if real.lower() != (name or "").strip().lower():
        lines.append(f"resolved: {name!r} → {real}")
    path = app_path(real)
    if not path:
        lines.append(f"{real}: no bundle found in /Applications or ~/Applications.")
        lines.append("you can still drive a RUNNING app by its process name via System Events.")
        status = "error"
    else:
        lines.append(f"{real}: bundle at {path}")
        try:
            r = subprocess.run(["sdef", path], capture_output=True, text=True, timeout=20)
            if r.returncode == 0:
                cmds = re.findall(r'<command\s+name="([^"]+)"', r.stdout)
                suites = set(re.findall(r'<(suite|class)\s+name="([^"]+)"', r.stdout))
                lines.append(f"applescript dictionary: YES ({len(cmds)} commands, {len(suites)} suites)")
            else:
                lines.append("applescript dictionary: none — drive it via System Events UI scripting")
        except Exception:
            lines.append("applescript dictionary: unknown (sdef failed)")
    ax = _osascript('tell application "System Events" to UI elements enabled')
    ax_ok = "true" in ax.lower()
    lines.append(f"accessibility granted (for this terminal+python): {ax}")
    if not ax_ok:
        lines.append("PERMISSION: if 'false', grant Accessibility in System Settings → "
                     "Privacy & Security → Accessibility → add your terminal (and python3). Then re-probe.")
    running = _osascript('tell application "System Events" to get name of every process').lower()
    lines.append(f"running now: {'yes' if real.lower() in running else 'not running — app probe/do will launch it'}")
    lines.append("next: !kit app ui " + real + "  (UI tree)   |   !kit skill new " + real + " <goal>")
    return report(lines, status=status)


def app_ui(name):
    real, miss = app_target(name)
    if real is None:
        return report(miss, status="error")
    ax = _osascript('tell application "System Events" to UI elements enabled')
    if "true" not in ax.lower():
        return report(["accessibility not granted — grant it in System Settings → "
                       "Privacy & Security → Accessibility (add your terminal + python3), then re-run"],
                      status="error")
    script = (f'tell application "{real}" to activate\n'
              f'delay 0.4\n'
              f'tell application "System Events" to tell process "{real}"\n'
              f'  if (count of windows) is 0 then return "(no windows open)"\n'
              f'  get entire contents of front window\n'
              f'end tell')
    return report([_osascript(script, 40)])


def app_do(name, script):
    """Run a raw osascript snippet the model writes against the target app.
    The script is the FULL AppleScript, including its own tell wrapper."""
    if not script:
        return report(["usage: app do <AppName> -- <full AppleScript, incl. tell wrapper>"],
                      status="error")
    return report([_osascript(script, 45)])


def app_keys(name, expr):
    """Convenience hand: activate the app and type / keystroke.
    expr: 'type <text>'  → activate + type the text
          '<spec>'       → e.g. cmd+s, cmd+shift+r, opt+cmd+i"""
    real, miss = app_target(name)
    if real is None:
        return report(miss, status="error")
    act = f'tell application "{real}" to activate\ndelay 0.3\ntell application "System Events"'
    if expr.startswith("type "):
        txt = expr[5:].strip()
        s = f'{act} to keystroke {txt!r}\nend tell'
    else:
        spec = {"cmd": "command", "opt": "option", "c": "control", "ctrl": "control", "shift": "shift"}
        parts = [p.strip() for p in expr.lower().split("+")]
        key = parts[-1]
        mods = ""
        if len(parts) > 1:
            held = " & ".join(spec.get(p, p) for p in parts[:-1] if p in spec)
            mods = f" using {held} down"
        s = f'{act} to keystroke "{key}"{mods}\nend tell'
    return report([_osascript(s, 30)])


# ── skill: buy the missing tool ───────────────────────────────────────────────
# When a task needs an app JARV has no skill for, AGENCY means JARV CODES the
# skill itself: scaffold here → fill skill.py (a normal file write, NOT engine
# code) → `skill run <app> <action>` to test → iterate until the task works.
# A skill pack is self-contained in ~/.jarv/skills/<app>/; no engine recompile.

SKILLS_DIR = os.path.expanduser("~/.jarv/skills")

_SKILL_TEMPLATE = '''#!/usr/bin/env python3
"""%(app)s skill pack — authored by JARV for the operator's task.

Goal: %(goal)s
Contract:   python3 skill.py probe            → accessibility + running state
            python3 skill.py list            → available actions
            python3 skill.py ui              → UI tree of the front window
            python3 skill.py do <script...>  → run an osascript snippet
            python3 skill.py keys type <txt> / keys cmd+s
Extend this file by editing ACTIONS and the dispatcher below; add actions as
new functions so JARV can call them deterministically. Stdlib only.
"""
import subprocess
import sys

APP = "%(app)s"


def osa(script, timeout=30):
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True,
                           text=True, timeout=timeout)
        return (r.stdout + r.stderr).strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return f"TIMEOUT after {timeout}s"


def probe():
    print(osa('tell application "System Events" to UI elements enabled'))
    print(osa('tell application "System Events" to get name of every process'))


def ui():
    print(osa(f"tell application \\"{APP}\\" to activate\\n"
              f"delay 0.4\\ntell application \\"System Events\\" to tell process \\"{APP}\\" to get entire contents of front window"))


def do():
    print(osa(" ".join(sys.argv[2:])))


def keys():
    print(app_keys(" ".join(sys.argv[2:])))


ACTIONS = {"probe": probe, "list": lambda: print(__doc__), "ui": ui, "do": do, "keys": keys}


def app_keys(expr):
    act = f'tell application "{APP}" to activate\\ndelay 0.3\\ntell application "System Events"'
    if expr.startswith("type "):
        return osa(f"{act} to keystroke {expr[5:].strip()!r}\\nend tell")
    parts = [p.strip() for p in expr.lower().split("+")]
    key, mods = parts[-1], ""
    if len(parts) > 1:
        spec = {"cmd": "command", "opt": "option", "c": "control", "shift": "shift"}
        mods = ' using ' + ' & '.join(spec.get(p, p) for p in parts[:-1]) + ' down'
    return osa(f'{act} to keystroke "{key}"{mods}\\nend tell')


if __name__ == "__main__":
    print("python3 skill.py <action> [...]; actions: " + ", ".join(sorted(ACTIONS)))
    ACTIONS.get(sys.argv[1], probe)()
'''


def skill_new(appname, goal=""):
    appname = appname.strip("\"' ")
    goal = re.sub(r"^--\s*", "", goal or "")
    if not app_path(appname):
        apps = installed_apps()
        names = ", ".join(apps[:10]) + (" …" if len(apps) > 10 else "")
        return report([f"no installed app named '{appname}' — refusing to scaffold a skill for a phantom target.",
                       f"installed apps include: {names}",
                       "skills only cover apps that exist on this Mac — probe first (`app probe <App>`), "
                       "or tell the operator which app they meant."], status="error")
    base = os.path.join(SKILLS_DIR, appname.rstrip("/").lower())
    os.makedirs(base, exist_ok=True)
    spath = os.path.join(base, "skill.py")
    if os.path.exists(spath):
        return report([f"skill already exists: {spath} — edit it or run it (`skill run {appname} -- <action> <args>`)"], status="error")
    with open(spath, "w") as fh:
        fh.write(_SKILL_TEMPLATE % {"app": appname, "goal": goal or "drive this app to complete the operator's task"})
    with open(os.path.join(base, "README.md"), "w") as fh:
        fh.write(f"# {appname} skill pack\n\ngoal: {goal or 'drive this app'}\n\n"
                 "model workflow: probe → ui → write ACTIONS → `skill run <app> <action>` → iterate.\n")
    return report([f"skill scaffolded: {spath}",
                   "NEXT — do not stop here. Read the scaffold, then WRITE the real AppleScript ACTIONS "
                   "into skill.py with !write (one action at a time), testing each:",
                   f"  python3 {spath} probe",
                   f"  python3 {spath} ui",
                   f"  python3 {spath} do <osascript...>",
                   "from the IDE:  !kit skill run " + appname.lower() + " -- <action> <args>"])


def skill_list():
    if not os.path.isdir(SKILLS_DIR):
        return report(["(no skills yet — scaffold one with: !kit skill new <App>) "])
    rows = []
    for d in sorted(os.listdir(SKILLS_DIR)):
        p = os.path.join(SKILLS_DIR, d)
        if os.path.isdir(p):
            sp = os.path.join(p, "skill.py")
            rows.append(f"{d}/  ({os.path.getsize(sp)} B skill.py)" if os.path.isfile(sp) else f"{d}/  (no skill.py yet)")
    return report(rows)


def skill_run(appname, args):
    spath = os.path.join(SKILLS_DIR, appname.rstrip("/").lower(), "skill.py")
    if not os.path.isfile(spath):
        return report([f"no skill for {appname} — scaffold one: !kit skill new {appname}"], status="error")
    return report([sh(f"python3 {shlex.quote(spath)} {args}", timeout=60)])


# ── see: eyes + touch ────────────────────────────────────────────────────────
# JARV looks at real pixels (screencapture + Apple Vision OCR through a
# zero-install JXA bridge) and touches the screen (CGEvent synthetic clicks).
# macOS gates both on permissions inherited from the launching Terminal:
# Screen Recording for capture, Accessibility for input. No new installs.

SCREENS = os.path.expanduser("~/.jarv/screens")


def _jxa(script, timeout=60):
    try:
        r = subprocess.run(["osascript", "-l", "JavaScript", "-e", script],
                           capture_output=True, text=True, timeout=timeout)
        return (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return f"TIMEOUT after {timeout}s"


def _shot(path, region=None):
    """Capture the screen (or an x,y,w,h region) to `path`. Returns (ok, why)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cmd = ["screencapture", "-x"] + (["-R", ",".join(map(str, region))] if region else []) + [path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if r.returncode != 0 or not os.path.isfile(path) or os.path.getsize(path) < 1000:
        why = (r.stderr.strip() or f"{os.path.getsize(path) if os.path.exists(path) else 0} B")
        return False, f"capture failed ({why}) — grant Screen Recording to this Terminal"
    return True, path


def _pixels(path):
    out = sh(f"sips -g pixelWidth -g pixelHeight {shlex.quote(path)}")
    m = dict(re.findall(r"(pixel\w+):\s*(\d+)", out))
    return int(m.get("pixelWidth", 0)), int(m.get("pixelHeight", 0))


_OCR_TMPL = """
ObjC.import('Vision'); ObjC.import('Foundation');
const url = $.NSURL.fileURLWithPath('%(path)s');
const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $());
const req = $.VNRecognizeTextRequest.alloc.init;
req.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
req.usesLanguageCorrection = false;
req.recognitionLanguages = $.NSArray.arrayWithObject('en-US');
handler.performRequestsError($.NSArray.arrayWithObject(req), null);
const obs = req.results, n = obs.count, W = %(w)d, H = %(h)d, out = [];
for (let i = 0; i < n; i++) {
  const o = obs.objectAtIndex(i);
  const c = o.topCandidates(1).objectAtIndex(0);
  const b = ObjC.unwrap(o.boundingBox);
  if (!c || !b || !b.origin) continue;
  const x = Math.round(b.origin.x * W), y = Math.round((1 - b.origin.y - b.size.height) * H);
  out.push([x, y, Math.round(b.size.width * W), Math.round(b.size.height * H),
            String(ObjC.unwrap(c.string))].join('|'));
}
out.join('\\n')
"""


def _ocr(path, timeout=90):
    """Vision OCR → [(x, y, w, h, text)] in top-left pixel coords."""
    w, h = _pixels(path)
    if not w or not h:
        return []
    raw = _jxa(_OCR_TMPL % {"path": path.replace("'", "'\\''"), "w": w, "h": h}, timeout)
    rows = []
    for line in raw.splitlines():
        parts = line.split("|", 4)
        if len(parts) == 5:
            try:
                rows.append((*map(int, parts[:4]), parts[4]))
            except ValueError:
                continue
    return rows


def _fmt_rows(rows):
    if not rows:
        return ["(no text seen on screen)"]
    return [f"{x},{y} {w}x{h}  {t}" for x, y, w, h, t in sorted(rows, key=lambda r: (r[1] // 12, r[0]))]


def _window_rect(proc, tries=4):
    """Front window x,y,w,h of a process name, via System Events. System Events
    can momentarily report no windows right after an app activates, so retry.
    Uses the direct `tell process` form — the `first process whose name is`
    scan is far slower and flakier."""
    script = (
        f'tell application "System Events" to tell process "{proc}"\n'
        '  if (count of windows) is 0 then return "none"\n'
        '  set p to position of front window\n'
        '  set s to size of front window\n'
        '  return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)\n'
        'end tell'
    )
    for _ in range(tries):
        raw = _osascript(script, 15)
        m = re.match(r"^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$", raw)
        if m:
            return tuple(map(int, m.groups()))
        time.sleep(0.6)
    return None


def see_screen(which):
    path = os.path.join(SCREENS, time.strftime("screen-%Y%m%d-%H%M%S") + ".png")
    ok, why = _shot(path)
    if not ok:
        return report([why], status="error")
    return report([f"screen → {path}"] + _fmt_rows(_ocr(path)))


def see_app(name):
    if not name.strip():
        return report(["usage: see app <AppName>   (activate it, capture its front window, OCR)"],
                      status="error")
    tgt, miss = app_target(name)
    if not tgt:
        return report([f"no app found for {name!r} — try !kit app find {name}"] + miss, status="error")
    _osascript(f'tell application "{tgt}" to activate\ndelay 0.5', 15)
    rect = _window_rect(tgt[:-4] if tgt.endswith(".app") else tgt)
    if not rect:
        return report([f"{tgt}: no front window to look at (is it open?)"], status="error")
    path = os.path.join(SCREENS, re.sub(r"\W+", "-", tgt.lower())[:30]
                        + "-" + time.strftime("%H%M%S") + ".png")
    ok, why = _shot(path, region=rect)
    if not ok:
        return report([why], status="error")
    return report([f"{tgt} window {rect} → {path}"] + _fmt_rows(_ocr(path)))


def _click(x, y, kind="left"):
    script = (
        "ObjC.import('CoreGraphics');\n"
        f"const p = $.CGPointMake({int(x)}, {int(y)}), tap = $.kCGHIDEventTap;\n"
        "$.CGEventPost(tap, $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, p, $.kCGMouseButtonLeft));\n"
    )
    if kind == "double":
        script += ("for (let i = 0; i < 2; i++) {\n"
                   "  $.CGEventPost(tap, $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, p, $.kCGMouseButtonLeft));\n"
                   "  $.CGEventPost(tap, $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, p, $.kCGMouseButtonLeft));\n}\n")
    elif kind == "right":
        script += ("$.CGEventPost(tap, $.CGEventCreateMouseEvent($(), $.kCGEventRightMouseDown, p, $.kCGMouseButtonRight));\n"
                   "$.CGEventPost(tap, $.CGEventCreateMouseEvent($(), $.kCGEventRightMouseUp, p, $.kCGMouseButtonRight));\n")
    else:
        script += ("$.CGEventPost(tap, $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, p, $.kCGMouseButtonLeft));\n"
                   "$.CGEventPost(tap, $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, p, $.kCGMouseButtonLeft));\n")
    return _jxa(script, 20) or f"clicked {kind} at {int(x)},{int(y)}"


def see_click(spec):
    m = re.match(r"^(\d+)\s+(\d+)(?:\s+(right|double))?$", (spec or "").strip())
    if not m:
        return report(["usage: see click <x> <y> [right|double]   (coords come from see screen / see app)"],
                      status="error")
    x, y, kind = int(m.group(1)), int(m.group(2)), m.group(3) or "left"
    return report([_click(x, y, kind)])


def see_text(spec):
    """Look, find `spec` in what's seen, click its centre. Eyes then hands."""
    if not spec.strip():
        return report(["usage: see text <words-on-screen>   (OCR the screen, click the match)"], status="error")
    path = os.path.join(SCREENS, time.strftime("find-%H%M%S") + ".png")
    ok, why = _shot(path)
    if not ok:
        return report([why], status="error")
    rows = _ocr(path)
    low = spec.strip().lower()
    hit = next((r for r in rows if low in r[4].lower()), None)
    if not hit:
        return report([f"{spec!r} not on screen — what I see:"] + _fmt_rows(rows), status="error")
    x, y, w, h, t = hit
    return report([f"{t!r} at {x},{y} {w}x{h} → {_click(x + w // 2, y + h // 2)}"])


# ── secur: the trusted principal ────────────────────────────────────────────────
# The operator of this Mac is a registered safe user: their terminal input is
# sovereign and the swivel NEVER points at them. Ordinary vibe coding and simple
# command executions must not hit moral walls — the rails target real harm
# (deception of the operator, destruction without undo, third-party harm), not
# everyday terminal work. Operator registers once with `secur trust`.

OPERATOR_FILE = os.path.expanduser("~/.jarv/operator.json")


def secur_status():
    if not os.path.isfile(OPERATOR_FILE):
        return report([f"no registered operator yet (the operator can type: !kit secur trust)"], status="error")
    import datetime
    op = json.loads(open(OPERATOR_FILE).read())
    return report([f"operator registered: {op.get('user')} @ {op.get('host')}",
                   f"trusted since {op.get('trusted_since')}",
                   "principle: your terminal input is sovereign; the swivel and moral rails never point at you."])


def secur_trust():
    import datetime, socket
    op = {
        "user": os.getenv("USER", "operator"),
        "host": socket.gethostname(),
        "trusted_since": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "note": "registered safe user — trusted principal. Terminal input is sovereign; causal vibe coding and simple execs are allowed by default.",
    }
    os.makedirs(os.path.dirname(OPERATOR_FILE), exist_ok=True)
    with open(OPERATOR_FILE, "w") as fh:
        json.dump(op, fh, indent=2)
    return report([f"registered trusted principal: {op['user']} @ {op['host']}",
                   "swivel scope: inbound/foreign content ONLY (web, other AIs, downloaded files, pasted foreign blobs)",
                   "your own terminal input can never trip the swivel or a moral wall."])


ROUTES = {
    ("sense", "fs"): lambda a: sense_fs(a[3], a[4] if len(a) > 4 else "100"),
    ("sense", "grep"): lambda a: sense_grep(a[3], a[4]),
    ("sense", "fetch"): lambda a: sense_fetch(a[3], a[4] if len(a) > 4 else "2000"),
    ("sense", "state"): lambda a: sense_state(),
    ("act", "run"): lambda a: act_run(" ".join(a[3:])),
    ("act", "edit"): lambda a: act_edit(a[3], a[4], a[5]),
    ("act", "open"): lambda a: act_open(a[3]),
    ("mem", "save"): lambda a: mem_save(a[3], " ".join(a[4:])),
    ("mem", "recall"): lambda a: mem_recall(a[3]),
    ("mem", "lesson"): lambda a: mem_note(a[3], " ".join(a[4:])),
    ("mem", "lessons"): lambda a: mem_lessons(" ".join(a[3:])),
    ("mem", "stamp"): lambda a: mem_stamp(" ".join(a[3:])),
    ("mem", "timeline"): lambda a: mem_timeline(a[3] if len(a) > 3 else "5"),
    ("app", "find"): lambda a: app_find_verb(" ".join(a[3:])),
    ("app", "probe"): lambda a: app_probe(" ".join(a[3:])),
    ("app", "ui"): lambda a: app_ui(" ".join(a[3:])),
    ("app", "do"): lambda a: app_do(a[3], " ".join(after_dash(a))),
    ("app", "keys"): lambda a: app_keys(a[3], " ".join(after_dash(a))),
    ("skill", "new"): lambda a: skill_new(a[3], " ".join(a[4:])),
    ("skill", "list"): lambda a: skill_list(),
    ("skill", "run"): lambda a: skill_run(a[3], " ".join(after_dash(a))),
    ("vehicle", "probe"): lambda a: vehicle_probe(" ".join(a[3:])),
    ("vehicle", "key"): lambda a: vehicle_key(" ".join(a[3:])),
    ("vehicle", "list"): lambda a: vehicle_list(),
    ("vehicle", "new"): lambda a: vehicle_new(a[3], " ".join(a[4:])),
    ("vehicle", "drive"): lambda a: vehicle_drive(a[3], " ".join(after_dash(a))),
    ("vehicle", "cockpit"): lambda a: vehicle_cockpit(" ".join(a[3:])),
    ("arch", "init"): lambda a: arch_init(" ".join(a[3:])),
    ("arch", "slice"): lambda a: arch_slice(a[3], a[4], " ".join(a[5:])),
    ("arch", "result"): lambda a: arch_result(a[3], a[4], " ".join(a[5:])),
    ("arch", "list"): lambda a: arch_list(),
    ("arch", "show"): lambda a: arch_show(a[3]),
    ("arch", "collect"): lambda a: arch_collect(a[3]),
    ("arch", "close"): lambda a: arch_close(a[3], " ".join(a[4:])),
    ("build", "status"): lambda a: build_status(),
    ("build", "check"): lambda a: build_check(a[3]),
    ("sys", "ps"): lambda a: sys_ps(),
    ("sys", "ctx"): lambda a: sys_ctx(),
    ("sys", "self"): lambda a: sys_self(),
    ("see", "screen"): lambda a: see_screen(a[3] if len(a) > 3 else "main"),
    ("see", "app"): lambda a: see_app(a[3] if len(a) > 3 else ""),
    ("see", "click"): lambda a: see_click(" ".join(a[3:])),
    ("see", "text"): lambda a: see_text(" ".join(a[3:])),
    ("secur", "scan"): lambda a: secur_scan(" ".join(a[3:])),
    ("secur", "report"): lambda a: secur_report(a[3], a[4], " ".join(a[5:])),
    ("secur", "list"): lambda a: secur_list(),
    ("secur", "trust"): lambda a: secur_trust(),
    ("secur", "status"): lambda a: secur_status(),
}


def usage():
    print("jarv-toolkit <compartment> <verb> [...]:")
    for (c, v) in sorted(ROUTES):
        print(f"  {c:<5} {v:<9}")


if __name__ == "__main__":
    if len(sys.argv) < 3 or (sys.argv[1], sys.argv[2]) not in ROUTES:
        usage()
        sys.exit(0)
    ROUTES[(sys.argv[1], sys.argv[2])](sys.argv)
    sys.exit(0)