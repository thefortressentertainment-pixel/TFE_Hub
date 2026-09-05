# Quantized AI Setup for M1 Mac

This setup configures Fortress Hub to use **local quantized models** first,
preventing cloud provider token limits from being exhausted.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  M1 Mac with Ollama (local quantized models)             │
│  ┌──────────────────────────────────────────────────┐   │
│  │  qwen2.5:0.5b  (397MB)  — lightweight, fast      │   │
│  │  qwen2.5:1.5b  (986MB)  — reasoning, quality      │   │
│  │  GGUF quantization, Apple Silicon Metal accelerated │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  Fortress Hub Backend (.env)                             │
│    GENIE_AI_LOCAL_FIRST=true                             │
│    OLLAMA_BASE_URL=http://127.0.0.1:11434/v1             │
│    OLLAMA_MODELS=qwen2.5:1.5b,qwen2.5:0.5b               │
│                                                         │
│  Moltis Config (template.toml)                          │
│    [providers.ollama] first in failover chain            │
│    Agents tier-assigned: 1.5b for leaders/ops, 0.5b for grunts  │
│                                                         │
│  OpenChamber Extension (opencode.json)                   │
│    "model": "ollama/qwen2.5:1.5b"                        │
│    "small_model": "ollama/qwen2.5:0.5b"                  │
│    provider.ollama.baseURL → http://127.0.0.1:11434/v1  │
└─────────────────────────────────────────────────────────┘
```

## Quantized Models Installed

| Model | Size | Use Case | M1 Performance |
|-------|------|----------|----------------|
| `qwen2.5:0.5b` | 397MB | Fast tasks, grunt/support agents | Very fast, low memory |
| `qwen2.5:1.5b` | 986MB | Complex reasoning, leadership/ops | Balanced speed/quality |

## Configuration Files Modified

1. **`backend/.env`** - Set `GENIE_AI_LOCAL_FIRST=true`, configured Ollama endpoint
2. **`backend/.env.example`** - Updated defaults for quantization
3. **`moltis/template.toml`** - Prioritized Ollama in provider chain, tiered model assignment
4. **`moltis/scripts/build-config.js`** - Updated TIER_MODEL map to use quantized models
5. **`moltis/build/moltis.toml`** - Regenerated with quantized model assignments
6. **`~/.config/opencode/opencode.json`** - Directs OpenChamber extension to local models
   - `"model": "ollama/qwen2.5:1.5b"` and `"small_model": "ollama/qwen2.5:0.5b"`
   - Defines a custom `ollama` provider (`npm: @ai-sdk/openai-compatible`) pointing at
     `http://127.0.0.1:11434/v1` so opencode knows how to reach the local Ollama API
   - Official docs reference: https://opencode.ai/docs/providers/#ollama

## Agent Tier → Model Mapping

| Tier | Agents | Model | Rationale |
|------|--------|-------|-----------|
| Leadership (3) | General Prestyn, Mayor Hancok, Elder Maxxn | qwen2.5:1.5b | Strategic reasoning needs more context |
| Operations (4) | Reporter Pyper, Nick Valentyne, Dr. Kyuri, The Mechanist | qwen2.5:1.5b | Technical tasks need quality |
| Specialist (4) | Mister Handy Hax, Paladin Danze, Curie, Courier | qwen2.5:1.5b | Specialized knowledge tasks |
| Support (4) | Perimeter Monitor, Sentry Bot, Protectron, Eyebot | qwen2.5-coder:0.5b | Simple monitoring/replying; tool-call tuned |
| Grunt (4) | Mole Ratt, Bloat Fli, BroodMother, Synth | qwen2.5-coder:0.5b | Hands work via bridge dispatch; doesn't need large context |
| Heavy (3) | Mr. Gutsy, Liberty Prime, Deathclaw | qwen2.5-coder:0.5b | High-risk tasks, fast execution |

## How It Solves the Token Limit Problem

Before: All 22 agents + OpenChamber were using cloud models (DeepSeek, OpenRouter, OpenCode)
which share a single quota that was exhausted in one burst.

After: All 22 agents use local quantized models running on your M1 Mac:
- No cloud API calls (unless local models fail)
- No shared token quota
- Each agent operates independently with infinite local context
- Only complex coding tasks fall back to the OpenCode Zen bridge (big-pickle)

## Changing the LLM model on Moltis

Every curated local chat model is registered under `[providers.ollama] models`
in `moltis/template.toml`, so they all appear as options. You can switch at
three levels:

1. **Per session (web chat).** Open the gateway UI (`moltis gateway`, then
   `https://127.0.0.1:63849`) and use the **Model Dropdown** in the chat
   toolbar. Each session remembers its own model.
2. **Per agent tier (default config).** Agent presets are generated from
   `backend/src/settlement.js` via `moltis/scripts/build-config.js`, using the
   `TIER_MODEL` map. The fast path is the helper:

   ```bash
   moltis/set-model.sh list                                    # see options + current map
   moltis/set-model.sh default qwen2.5:1.5b                    # everything on the 1.5b
   moltis/set-model.sh split qwen3:1.7b qwen2.5-coder:0.5b     # reasoning vs hands tiers
   moltis/set-model.sh split llama3.2:3b-instruct-q8_0 qwen2.5:0.5b
   ```

   It validates the model is really installed in Ollama, rebuilds the config
   from the roster, installs it to `~/.config/moltis/moltis.toml`, and runs
   `moltis config check` + `doctor`. Restart the gateway to apply.
3. **Manual edit.** Edit `[providers.ollama] models` and/or the per-preset
   `model = "ollama/<name>"` lines in `moltis/template.toml`, then rebuild:
   `node moltris/scripts/build-config.js && sh moltris/install.sh`.

### Available local models (as installed on this Mac)

| Model | Size | Best for |
|-------|------|----------|
| `qwen2.5-coder:0.5b` | 397MB | Fast tool-call tuned — grunt/hands tiers |
| `qwen2.5:0.5b` | 397MB | Smallest/fastest generic replies |
| `qwen2.5:1.5b` | 986MB | Balanced quality — leadership/ops/specialist |
| `qwen3:0.6b` | 522MB | Newer Qwen3 family, thinking capable |
| `qwen3:1.7b` | 1.4GB | Best reasoning per GB among Qwen3 locals |
| `llama3.2:3b-instruct-q8_0` | 3.4GB | Strongest local option (Q8) — needs RAM headroom |
| `llama3.2:latest` | 2.0GB | General instruct fallback |