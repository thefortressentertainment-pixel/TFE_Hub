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
    app     probe|ui|do|keys         the hand: drive ANY app on this Mac (AppleScript
                                      + System Events accessibility: click, type,
                                      menus, keystrokes). probe reports what the
                                      target exposes BEFORE anything is touched
    skill   new|list|run             buy the missing tool: scaffold a self-contained
                                      skill pack in ~/.jarv/skills/<app>/ that JARV
                                      fills, tests and iterates until the task works
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
import subprocess
import sys
import time
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
        return (r.stdout + r.stderr).strip() or f"(exit {r.returncode}, no output)"
    except subprocess.TimeoutExpired:
        return f"TIMEOUT after {timeout}s"


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

def sense_fs(path, lines):
    if not os.path.exists(path):
        return report([f"not found: {path}"], status="error")
    if os.path.isdir(path):
        return report([pipe(f"ls -la {shlex.quote(path)} | head -{min(int(lines), 100)}")])
    with open(path, errors="replace") as fh:
        return report(["\n".join(fh.read().splitlines()[: max(1, min(int(lines), 500))])])


def sense_grep(pattern, path):
    return report([pipe(f"grep -nE {shlex.quote(pattern)} {shlex.quote(path)} 2>&1 | head -60")])


def sense_fetch(url, maxchars):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "jarv-toolkit/1.0"})
        data = urllib.request.urlopen(req, timeout=20).read()
        try:
            txt = data.decode("utf-8", "replace")
        except Exception:
            txt = f"<binary/undecodable {len(data)} bytes>"
        return report([txt[: max(2000, int(maxchars))]])
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


def app_path(name):
    for base in ("/System/Applications", "/Applications",
                 os.path.expanduser("~/Applications")):
        for suffix in ("", ".app"):
            p = os.path.join(base, name.rstrip("/") + suffix)
            if os.path.isdir(p):
                return p
    hit = pipe(f"mdfind -name {shlex.quote(name)} 2>/dev/null | grep -m1 -e '\\.app$'", timeout=20)
    if not hit or hit.startswith(("Unknown option", "Usage:", "TIMEOUT", "(exit")):
        return None
    return hit or None


def app_probe(name):
    """Read-only recon on an app BEFORE touching it: bundle location, scripting
    dictionary, accessibility permission, running state."""
    lines = []
    path = app_path(name)
    status = "ok"
    if not path:
        lines.append(f"{name}: no bundle found in /Applications or ~/Applications.")
        lines.append("you can still drive a RUNNING app by its process name via System Events.")
        status = "error"
    else:
        lines.append(f"{name}: bundle at {path}")
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
    lines.append(f"running now: {'yes' if name.lower() in running else 'not running — app probe/do will launch it'}")
    lines.append("next: !kit app ui " + name + "  (UI tree)   |   !kit skill new " + name + " <goal>")
    return report(lines, status=status)


def app_ui(name):
    ax = _osascript('tell application "System Events" to UI elements enabled')
    if "true" not in ax.lower():
        return report(["accessibility not granted — grant it in System Settings → "
                       "Privacy & Security → Accessibility (add your terminal + python3), then re-run"],
                      status="error")
    script = (f'tell application "{name}" to activate\n'
              f'delay 0.4\n'
              f'tell application "System Events" to tell process "{name}"\n'
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
    act = f'tell application "{name}" to activate\ndelay 0.3\ntell application "System Events"'
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
              f"delayed 0.4\\ntell application \\"System Events\\" to tell process \\"{APP}\\" to get entire contents of front window"))


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
                   "fill it in (one action at a time), then test:",
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
    ("app", "probe"): lambda a: app_probe(a[3]),
    ("app", "ui"): lambda a: app_ui(a[3]),
    ("app", "do"): lambda a: app_do(a[3], " ".join(after_dash(a))),
    ("app", "keys"): lambda a: app_keys(a[3], " ".join(after_dash(a))),
    ("skill", "new"): lambda a: skill_new(a[3], " ".join(a[4:])),
    ("skill", "list"): lambda a: skill_list(),
    ("skill", "run"): lambda a: skill_run(a[3], " ".join(after_dash(a))),
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