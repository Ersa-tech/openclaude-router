# OpenClaude Router (OpenRouter-first)

OpenClaude Router keeps the Claude Code agent/tool runtime, but routes model traffic through an **OpenRouter-first OpenAI-compatible shim**.

## Quick start

```bash
export CLAUDE_CODE_USE_OPENAI=1
export OPENROUTER_API_KEY=sk-or-...
export OPENROUTER_MODEL=openai/gpt-4o-mini
# optional
export OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
export OPENROUTER_STREAM=auto   # auto|on|off
export OPENROUTER_MODELS=openai/gpt-4o-mini,google/gemini-2.5-flash

openclaude
```

Compatibility aliases supported in this PR:
- `OPENAI_API_KEY` → `OPENROUTER_API_KEY`
- `OPENAI_BASE_URL` → `OPENROUTER_BASE_URL`
- `OPENAI_MODEL` → `OPENROUTER_MODEL`

## Profiles

Set `OPENROUTER_PROFILE` or use launcher scripts:
- `free` (opt-in only; never default for autonomous coding)
- `balanced`
- `reliable`
- `cheap`

Commands:

```bash
bun run dev:openrouter
bun run dev:free
bun run dev:cheap
bun run dev:reliable
```

## Behavior notes

- If selected model metadata indicates weak/no tools support, runtime warns and degrades by omitting tool declarations rather than failing deep in the loop.
- Model fallback chain: `OPENROUTER_MODEL` + optional `OPENROUTER_MODELS` + profile defaults.
- OpenRouter `/models` metadata is cached at `.openclaude/openrouter-models-cache.json`.
- Streaming mode is controlled via `OPENROUTER_STREAM=auto|on|off`.

## Runtime checks

```bash
bun run doctor:runtime
bun run doctor:runtime:json
bun run doctor:report
```

These validate OpenRouter config, compatibility aliases, reachability, and local-provider constraints.
