# ANATOMY.md — the body plan

JARV is one agent, not a settlement. This is the whole machine:

    terminal (operator)
      │  you> … replies
      ▼
    jarv/ide.py            the REPL: Ollama /api/chat, streaming, session files,
                           compaction, tool loop, doctrine lazy-loading
      │  two models
      ├─ fast  qwen3:4b-instruct-2507-q4_k_m-jarv   16k ctx  ⚡ execution
      └─ arch  qwen3:4b-thinking-2507-q8_0-jarv      8k ctx  🧠 planning
      │
      ├── jarv/toolkit.py  filing cabinet (sense/act/mem/build/arch/sys/secur)
      ├── jarv/docs/*      doctrine, loaded on demand with !doc
      │
      └── ~/.jarv/           persistent home
            ├─ sessions/<name>.jsonl     every turn, reloadable
            ├─ toolkit-memory.json        cross-session shared facts
            ├─ workbench/<id>-<slug>/     task ledgers: plan, results/NN.md, report
            └─ incidents/NNN-<slug>.md    the swivel's permanent record

## How it thinks

- Context = system doctrine (tiny) + this session's turns (auto-compacted when
  past budget). Doctrine is loaded lazily by an explicit `!doc`, so the window
  stays mostly working-memory, not wallpaper.
- Working memory that matters lives in files: workbench checkpoints for task
  state, `mem` for facts, incidents for hostility. Context that doesn't fit is
  check-boarded to disk, never silently dropped from intent.

## How feet work

- `!exec` → any shell command on the machine (full-machine sandbox), cwd
  tracked per session (repo by default).
- `!read/!write/!cwd` → filesystem access, output capped.
- `!kit` → the cabinet; `act edit` is the only mutator and it is fail-closed.
- `!kit sense fetch` → the internet, read-only and truncated; `sense fetch` and
  fetch-and-run one-liners pause auto-run until the operator's `/ok`.
- `!doc` → doctrine into context exactly when needed.
- `!model` → JARV escalates to arch for real thinking and drops back to fast to
  execute; the operator can switch too with `/model`.

## Failure posture

- Checks pause progress, never fake it. An aborted tool step returns its error
  as a system message; the loop keeps going or JARV stops-after-two and asks.
- Ctrl-C in the terminal cancels the current turn; the session file is saved
  before and after every exchange.