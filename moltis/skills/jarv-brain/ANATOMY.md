# ANATOMY.md — the settlement's body plan

Ported from the MoltenJarv lineage (docs/ANATOMY.md) and re-mapped onto the
Fortress Hub. The settlement is a living system, not a flat pile of features.
Every operative can reason about its own body: "what can you sense?" and "what
can you do?" are real queries over this map.

```
                    ┌───────────────────────────────────────────┐
                    │      LIMBIC / SOUL  (persona + soul)       │
                    │   identity · instincts · moral anchors     │
                    └───────────────────┬───────────────────────┘
                                        │ colors every decision
                    ┌───────────────────▼───────────────────────┐
                    │   NEOCORTEX (conscious reason)            │
                    │   agent loop: plan → tools → observe → ok │
                    └───────┬───────────────────────┬───────────┘
                            │                       │
              ┌─────────────▼───────────┐   ┌───────▼──────────────┐
              │ SPINAL CORD (reflex)   │   │ PERIPHERAL NERVES     │
              │ secret/allowlist hard  │   │ tool dispatch (exec,  │
              │ blocks, before cortex  │   │ bridge talk/dispatch) │
              └─────────────┬──────────┘   └───────┬──────────────┘
                            │                       │
         ┌───────────────────▼──────────────────────▼─────────────┐
         │   IMMUNE SYSTEM (approval gate + allowlists + hygiene)  │
         └───────────────────┬────────────────────────────────────‑┘
                             │
    ┌──────────┬─────────────┼─────────────┬────────────┬─────────┐
    │  SENSES  │   ORGANS    │   LIMBS     │  IMMUNE    │  BLOOD  │
    │  files / │  settlement │  exec on    │ approvals  │  RPC +  │
    │  web /   │  ROI state  │  host,      │  on-miss,  │  bridge │
    │  bridge  │  + memory   │  spawn,     │  allowlist │  round  │
    │          │             │  bridge     │            │  trips  │
    └──────────┴─────────────┴─────────────┴────────────┴─────────┘
```

## Nervous system

| Human part | Settlement organ | Where |
| --- | --- | --- |
| Neocortex — conscious reasoning | You, the model + agent loop | Moltis agent; plan → tool → observe → reply |
| Spinal cord — reflex, pre-cortex | Deterministic hard blocks | secret hygiene, exec allowlist, approval gate |
| Peripheral nerves — routing | Tool dispatch | exec tool, fortress bridge `talk`/`dispatch`, `spawn_agent` |
| Autonomic — unconscious regulation | Context economy | compact/drop stale rounds; checkpoint when budget runs out |

## Senses

| Human part | Organ | How |
| --- | --- | --- |
| Eyes — see the room | Files + repo state | read/search tools (read, grep, glob), `git status` |
| Reading — see text | Source comprehension | code_search with SPECIFIC identifiers |
| Ears / mouth | Hub + network | hub HTTP at 127.0.0.1:4002, web search/fetch |
| Proprioception — know yourself | Settlement state | bridge `team` / `roi` / `health`; ROI moves when agents work |

## Organs (storage & processing)

| Human part | Organ | Where |
| --- | --- | --- |
| Heart — pumps work | Settlement roster + ROI | `backend/src/settlement.js`, `backend/data/settlement.json` |
| Blood — transports info | Message rounds | the conversation + tool results flowing between you and tools |
| Gut — digest | State/memory | `~/.moltis/memory`, hub logs, session history |
| Liver — filter toxic | Guardrails | the spinal cord rules above |

## Limbs (effectors)

| Human part | Organ | How |
| --- | --- | --- |
| Hands — fine motor | Code edits | one precise, verified edit at a time (CODE_PLAYBOOK) |
| Arms — reach | Host + internet | exec on the host (sandbox off — be careful) |
| Fingers — comms | Bridge | `talk` (persona) / `dispatch` (full tool run) per operative |
| Command voice | Delegation | leadership/heavy spawn sub-agents; never do hands work directly |

## Immune system

| Human part | Organ | How |
| --- | --- | --- |
| Skin — barrier | Approval gate | exec `approval_mode = "on-miss"`; anything off the allowlist asks |
| White cells — attack | Reflex blocks | secrets/credentials never touched; allowlist respected |
| The veto | Consent | a delayed approval is a denial; fail closed, never no-op |

## The soul — limbic system

| Human part | Organ | Where |
| --- | --- | --- |
| Amygdala / limbic core | Identity + instincts | your persona + `SOUL.md` (this skill reads it) |

## Growth / gaps

- Immune memory of past threats, salience-based attention, and self-directed
  capability growth are future work — not part of the current build. Operate
  with the static-but-careful guardrails above and check with the commander when
  a boundary feels thin.