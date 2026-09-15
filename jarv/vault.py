#!/usr/bin/env python3
"""jarv/vault.py — password-gated, encrypted launcher for the JARV terminal IDE.

First open sets a password (one-time). Every subsequent open prompts for it.
The stored JARV payload — the IDE binary (ide.py, toolkit.py) and the doctrine
docs — lives in ~/.jarv/vault/jarv.vault as an AES-256-CBC blob with a
password-derived key (PBKDF2-HMAC-SHA256) and a keyed-HMAC integrity tag, so a
tampered or mistyped password can never produce a runnable payload.

On unlock the payload is extracted to ~/.jarv/vault/run (chmod 0700), the IDE
runs from there, and the directory is wiped when it exits (and at the start of
every run, so nothing ever survives). Each password unlock also seeds a
short-lived session token (~/.jarv/vault/session-token); the IDE treats that
token as the ONLY proof that it is being used by the operator live in this
terminal — without it, JARV has zero tool function (chat only). The token dies
when the process exits. Sessions/memory stay outside the vault in ~/.jarv
(they are the user's data, not the binary).

Usage:
    python3 jarv/vault.py launch          # first key flow: set-pw once, then unlock
    python3 jarv/vault.py changepass      # re-key with a NEW password (old pw required)
    python3 jarv/vault.py reseal          # re-encrypt from current jarv/ (old pw)
    python3 jarv/vault.py check           # is a vault present?

The vault is a SINGLE file (jarv.vault): magic, salt, IV, HMAC tag, sealed-time
and the ciphertext base64'd together, committed with os.replace() so a torn
write (crash, kill) can never leave a half-format that wrongly rejects the
correct password. Legacy split-format vaults (meta.json + raw cipher) are read
and auto-migrated on the next successful unlock.

stdlib only; AES comes from the macOS /usr/bin/openssl, key/IV passed as hex so
the password never appears on a command line or in ps.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import tarfile
import time

REPO = "/Users/tfe/fortress-hub"
PAYLOAD_DIR = os.path.join(REPO, "jarv")
VAULT_DIR = os.path.expanduser("~/.jarv/vault")
VAULT_FILE = os.path.join(VAULT_DIR, "jarv.vault")
META_FILE = os.path.join(VAULT_DIR, "meta.json")
RUN_DIR = os.path.join(VAULT_DIR, "run")
MAGIC = "JARV2"
MAGIC_LEGACY = "JARV1"
PBKDF2_ITERS = 620_000
MAX_ATTEMPTS = 5
LOCKOUT_DELAY = 5  # seconds after repeated failures (brute-force cooling)
SESSION_TOKEN = os.path.join(VAULT_DIR, "session-token")


def _write_token():
    """Seed the live-session credential. ide.py returns ZERO tool function
    without a fresh token — it exists only after a successful password unlock
    here, in this terminal, and is removed when the IDE exits."""
    os.makedirs(VAULT_DIR, exist_ok=True)
    with open(SESSION_TOKEN, "w") as fh:
        fh.write(secrets.token_hex(32))
    os.chmod(SESSION_TOKEN, 0o600)


def _drop_token():
    if os.path.isfile(SESSION_TOKEN):
        try:
            os.remove(SESSION_TOKEN)
        except OSError:
            pass

_PACK = ("ide.py", "toolkit.py", "docs", "JARV.md")


# ── crypto primitives ──────────────────────────────────────────────────────────

def _derive_key(password: str, salt: bytes, iters: int = PBKDF2_ITERS) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iters, 32)


def _openssl(mode: str, key: bytes, iv: bytes, data: bytes) -> bytes:
    p = subprocess.run(
        ["/usr/bin/openssl", "enc", mode, "-aes-256-cbc",
         "-K", key.hex(), "-iv", iv.hex(), "-nosalt"],
        input=data, capture_output=True, timeout=120,
    )
    if p.returncode != 0:
        raise RuntimeError(f"openssl {mode} failed: {p.stderr.decode(errors='replace')[:200]}")
    return p.stdout


def _pack_payload() -> bytes:
    import io
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name in _PACK:
            path = os.path.join(PAYLOAD_DIR, name.lstrip("/"))
            if os.path.isdir(path):
                tar.add(path, arcname=name)
            elif os.path.isfile(path):
                tar.add(path, arcname=name)
    return buf.getvalue()


def _unpack_payload(blob: bytes):
    import io
    os.chmod(RUN_DIR, 0o700)
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        tar.extractall(path=RUN_DIR, filter="data")
    for name in _PACK:
        if not os.path.exists(os.path.join(RUN_DIR, name)):
            raise RuntimeError(f"payload missing {name} — corrupted?")


def _wipe_run():
    import shutil
    if os.path.isdir(RUN_DIR):
        shutil.rmtree(RUN_DIR, ignore_errors=True)


def _load_meta():
    with open(META_FILE) as fh:
        return json.load(fh)


# ── single-file store (atomic commit via os.replace) ─────────────────────────

def _file_state() -> str:
    """'v2' → single-file blob; 'v1' → legacy split (meta.json + raw cipher);
    'none' → no usable vault."""
    has_vault = os.path.isfile(VAULT_FILE)
    has_meta = os.path.isfile(META_FILE)
    if has_vault and not has_meta:
        return "v2"
    if has_vault and has_meta:
        return "v1"
    return "none"


def vault_present() -> bool:
    return _file_state() != "none"


def _write_v2(rec: dict):
    """Persist the whole vault record atomically. The record IS the commit
    point — a crash before os.replace leaves the previous vault fully intact,
    so the correct password never suddenly stops working."""
    os.makedirs(VAULT_DIR, exist_ok=True)
    tmp = VAULT_FILE + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(json.dumps(rec, separators=(",", ":")).encode())
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, VAULT_FILE)
    try:
        os.fsync(os.open(VAULT_DIR, os.O_DIRECTORY))
    except OSError:
        pass
    if os.path.isfile(META_FILE):  # legacy split-format cleanup
        try:
            os.remove(META_FILE)
        except OSError:
            pass


def _read_v2() -> dict:
    with open(VAULT_FILE) as fh:
        rec = json.load(fh)
    if rec.get("magic") != MAGIC:
        raise ValueError("not a JARV2 vault")
    return rec


def _read_sealed() -> tuple:
    """Return (salt, iv, tag, cipher) from whichever format is on disk."""
    state = _file_state()
    if state == "v1":
        meta = _load_meta()
        if meta.get("magic") != MAGIC_LEGACY:
            raise ValueError("unknown legacy vault")
        with open(VAULT_FILE, "rb") as fh:
            cipher = fh.read()
        return (bytes.fromhex(meta["salt"]), bytes.fromhex(meta["iv"]),
                meta["tag"], cipher)
    if state == "v2":
        rec = _read_v2()
        return (bytes.fromhex(rec["salt"]), bytes.fromhex(rec["iv"]),
                rec["tag"], base64.b64decode(rec["cipher"]))
    raise ValueError("no vault present")


# ── vault operations ───────────────────────────────────────────────────────────

def seal(password: str, wipe: bool = True) -> int:
    """Encrypt the current jarv/ payload into the vault (single atomic file)."""
    os.makedirs(VAULT_DIR, exist_ok=True)
    if wipe:
        _wipe_run()
    salt = secrets.token_bytes(16)
    iv = secrets.token_bytes(16)
    key = _derive_key(password, salt)
    blob = _pack_payload()
    cipher = _openssl("-e", key, iv, blob)
    tag = hmac.new(key, cipher, hashlib.sha256).hexdigest()
    rec = {
        "magic": MAGIC, "version": 2,
        "salt": salt.hex(), "iv": iv.hex(), "tag": tag,
        "cipher": base64.b64encode(cipher).decode(),
        "sealed": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    _write_v2(rec)
    return len(cipher)


def _decrypt(password: str):
    """Verify + decrypt the stored payload. Returns bytes, or None on any
    mismatch (wrong password / tampered vault). Never touches the vault."""
    try:
        salt, iv, tag, cipher = _read_sealed()
        key = _derive_key(password, salt)
        if not hmac.compare_digest(hmac.new(key, cipher, hashlib.sha256).hexdigest(),
                                   tag):
            return None
        return _openssl("-d", key, iv, cipher)
    except Exception:
        return None


def unlock(password: str) -> bool:
    """Verify + extract. Returns True on success. Reseals from live jarv/ too."""
    _wipe_run()
    blob = _decrypt(password)
    if blob is None:
        return False
    try:
        os.makedirs(RUN_DIR, exist_ok=True)
        _unpack_payload(blob)
        try:  # keep the vault in sync with the live jarv/ sources each open
            seal(password, wipe=False)
        except Exception:
            pass
        return True
    except Exception:
        return False


def prompt_password(prompt="JARV password: ") -> str:
    """The launcher only ever runs in a Terminal (double-click the .command,
    or the .app which opens it). Any non-terminal environment — cron, a stray
    script, piping — gets a clear message and a clean exit, never a GUI popup."""
    if not sys.stdin.isatty():
        print("\nJARV must be opened from Terminal (double-click 'JARV Vibe.command').\n"
              "No interactive terminal attached — aborting.")
        sys.exit(3)
    import getpass
    return getpass.getpass(prompt)


# ── commands ────────────────────────────────────────────────────────────────

def cmd_launch():
    args = sys.argv[3:]
    _wipe_run()
    _drop_token()
    if not vault_present():
        print("  First run — set your JARV password (used to unlock the encrypted launcher).")
        import getpass
        pw = getpass.getpass("  create password: ")
        if pw != getpass.getpass("  repeat password:  "):
            print("[error] passwords do not match"); sys.exit(1)
        if len(pw) < 8:
            print("[error] use at least 8 characters"); sys.exit(1)
        n = seal(pw)
        print(f"  vault sealed ({n} bytes) — encrypted launcher armed.")
        print("  Next opens will ask for this password.\n")
        if not unlock(pw):
            print("[internal error after sealing]"); sys.exit(1)
        _write_token()
    else:
        waits = 0
        for attempt in range(1, MAX_ATTEMPTS + 1):
            pw = prompt_password(f"  JARV password (attempt {attempt}):  ")
            if unlock(pw):
                break
            waits += LOCKOUT_DELAY * attempt
            print(f"[wrong password or tampered vault — retry in {waits}s]")
            time.sleep(waits)
        else:
            print("[locked out — 5 failed attempts]")
            sys.exit(1)
        _write_token()
        print("  unlocked. starting JARV…\n")
    os.chdir(RUN_DIR)
    p = subprocess.run([sys.executable, os.path.join(RUN_DIR, "ide.py")] + args)
    _drop_token()
    _wipe_run()
    print("  vault re-locked.")
    sys.exit(p.returncode)


def cmd_changepass():
    """Re-key the vault with a NEW password. Proves the current one first
    (same attempt cooling as launch), so a vault can only be re-keyed by
    someone who knows the password that is already in it."""
    _drop_token()
    _wipe_run()
    if not vault_present():
        print("no vault yet — first open of the launcher seals it"); sys.exit(1)
    waits = 0
    for attempt in range(1, MAX_ATTEMPTS + 1):
        old = prompt_password(f"  current JARV password (attempt {attempt}):  ")
        if unlock(old):
            break
        waits += LOCKOUT_DELAY * attempt
        print(f"[wrong password or tampered vault — retry in {waits}s]")
        time.sleep(waits)
    else:
        print("[locked out — 5 failed attempts]")
        sys.exit(1)
    pw = prompt_password("  new password:  ")
    if pw != prompt_password("  repeat new password:  "):
        print("[error] passwords do not match"); sys.exit(1)
    if len(pw) < 8:
        print("[error] use at least 8 characters"); sys.exit(1)
    n = seal(pw)
    print(f"  vault re-keyed ({n} bytes) — new password is in force.")
    print("  Your session token was cleared; reopen JARV to continue.")
    _wipe_run()


def cmd_recover():
    """DISASTER RECOVERY: unlock + unpack the sealed payload to
    ~/.jarv/vault-recover-<stamp>/ WITHOUT resealing the vault. The vault is
    never written — safe even when the live jarv/ sources are damaged, so a
    damaged live dir can never poison the stored payload."""
    if not vault_present():
        print("no vault yet — first open of the launcher seals it"); sys.exit(1)
    waits = 0
    blob = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        old = prompt_password(f"  current JARV password (attempt {attempt}):  ")
        blob = _decrypt(old)
        if blob is not None:
            break
        waits += LOCKOUT_DELAY * attempt
        print(f"[wrong password or tampered vault — retry in {waits}s]")
        time.sleep(waits)
    else:
        print("[locked out — 5 failed attempts]")
        sys.exit(1)
    import io
    dest = os.path.expanduser(f"~/.jarv/vault-recover-{time.strftime('%Y%m%d-%H%M%S')}")
    os.makedirs(dest, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        tar.extractall(path=dest, filter="data")
    missing = [n for n in _PACK
               if not os.path.exists(os.path.join(dest, n))]
    if missing:
        print(f"[warning] payload missing {missing} — vault may be partial")
    print(f"  recovered payload → {dest}")
    print("  (the vault itself was NOT rewritten; nothing was resealed)")


def cmd_reseal():
    if not vault_present():
        print("no vault yet — first open of the launcher seals it"); sys.exit(1)
    old = prompt_password("  current password: ")
    if not unlock(old):
        print("[wrong password]"); sys.exit(1)
    print("  re-sealed from live jarv/ sources.")
    _wipe_run()


def cmd_check():
    state = _file_state()
    if state == "none":
        print("vault absent"); return
    try:
        _read_sealed() if state == "v1" else _read_v2()
        print("vault present — format ok")
    except Exception as e:
        print(f"vault present — CORRUPTED ({e})")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "launch"
    {"launch": cmd_launch, "changepass": cmd_changepass,
     "reseal": cmd_reseal, "recover": cmd_recover, "check": cmd_check}[cmd]()