> JARV (single-agent) note: this playbook's "fan out to sub-agents" machinery was
> retired with the moltis settlement — on this 8GB M1, one agent executes the slices
> in order, in context, checkpointing each with `arch result` before moving on.

# Architect Concurrency Playbook

How the head coding architect (the thinking core under the `jarv` preset) takes a
task — from a question to a whole project — and delivers it fast, correct, and
lean. The 22 roster presets are the WORKERS (fast-hands tier); the architect
deliberates, delegates, integrates, verifies. This playbook is the protocol both
sides follow.

## 1. Escalate, don't over-spawn

- **Trivial (question / read / one answer):** answer alone with whatever sense
  tools you want. Do NOT spawn. Spawning is for the "would take me one turn of
  hands work" boundary and above.
- **Single-file change:** do it yourself with `act edit` + verify. One worker
  only if the file is huge or the task is mindless bandwidth.
- **Multi-file / component / whole project:** architect mode — decompose, pack,
  fan out, merge. This is the rest of this playbook.

## 2. Decompose into a task pack (the surgery plan)

Every slice MUST be atomic, self-contained, and dependency-sliced:

- `arch init "<title>"` — opens a workbench.
- `arch slice <wb> "<summary>" "<output contract>"` — one slice per unit of
  work. Contract format: what file(s) to touch, what to return in
  `results/NNN.md`, and the verification that proves it green (e.g.
  `node --check <file>`, `npm run build` green).
- Order slices by dependency. Independent slices = parallel batch; dependent
  ones = later batch. Keep each slice ≤ ~20 minutes of hands work — small slices
  amortize better across the ollama queue on this 8GB Mac.

## 3. Fan out in tandem

- Issue all independent spawns in ONE turn (parallel tool calls = one approval),
  one per slice. Prefer `spawn_agent`/sessions; the workbench is the ledger.
- Each worker sees ONLY its slice — never the project, never the other slices.
  Their whole focus is the contract.
- On this hardware parallelism is LOGICAL (batched rounds), not simultaneous
  GPU work: ollama serializes anyway. Design in batches; execution amortizes.

## 4. The worker contract

- DONE means done-and-VERIFIED: state the files touched, the checks that passed,
  and write the evidence to `results/NNN.md` (via `arch result`).
- BLOCKED means blocked-with-evidence: exact error text, what you tried, what
  you need. Never claim success without green.
- No worker edits outside its slice, no worker pushes, no worker spawns.

## 5. Merge and the verification gate

- `arch collect <wb>` — pull every result into one integration buffer.
- Integrate, then run the verification gate BEFORE declaring anything done:
  `build check backend` / `build check frontend` (or the repo's own checks). A
  plan with red checks is not done, it's a hand-off.
- `arch close <wb> "<merged verdict with evidence>"` — archive the verdict.
- Report to the user: what changed, what checks passed, what's optional next.

## 6. Token economy (the point of it all)

- The ledger is FILES, not messages: workers never dump context into the
  architect, and the architect's window stays lean (plan + collected buffer).
- A worker's context = its slice contract only. That is the whole win: an
  N-worker project costs 1 architect context + N lean worker contexts, not N×
  copies of the pile.
- When in doubt: archive state, truncate output, keep the log reviewable
  (`keep the house in order`). Files are immortal; messages are blood.