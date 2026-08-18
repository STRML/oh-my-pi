> Generated: 2026-08-18 | Token-lean format for LLM context

# oh-my-pi (omp) — architecture map

Monorepo at `~/git/forks/omp` (fork of can1357/oh-my-pi). Bun workspace + Rust
crates. Local feature branch `fix/model-provider-selector-shadow` carries unpushed
work — treat fork HEAD as the running code.

## Package surface

| Pkg `packages/` | Role |
|---|---|
| `coding-agent` | CLI: tools, session, TUI, extensions, MCP, compaction entry, mode/plans |
| `agent` | Agent loop, transport abstraction, state mgmt, compaction pipeline |
| `ai` | Unified LLM API, provider discovery/config, model routing |
| `snapcompact` | Bitmap-frame context compression (deterministic PNG archive, no LLM) |
| `utils` | Shared pi utils (logger, prompt, stringifyJson, isRecord) |
| `wire` | Shared wire protocol types |
| `natives` | Rust N-API bindings (image, PTY, shell, grep, PDF, audio, WebRTC) |
| `metaharness` | Benchmark runners + Harbor storage + REST/SSE + web dashboard |
| `stats` | Local usage observability dashboard |
| `catalog` | Model/provider catalog |
| `mnemopi` | Memory backend |
| `omptype` | Omptype helpers |
| `cosmic`/`pi-*` misc | Supporting libs |

## Agent loop (`packages/agent/src`)

- `agent-loop.ts` — streaming event normalization, tool call snapshotting
- `agent.ts` — `AgentCore`, message state, run lifecycle
- `append-only-context.ts` — stable-prefix cache + append-only log;
  `replaceTail()` reserved for compaction
- `compaction/` — the compaction pipeline (see below)
- `thinking.ts`, `telemetry.ts`, `tokenizer.ts`, `run-collector.ts`

## Compaction (`packages/agent/src/compaction`)

| File | Purpose |
|---|---|
| `compaction.ts` | Pure compaction funcs; ties pi-ai + snapcompact together |
| `compaction-v2-streaming.ts` | Remote V2 (Responses `compaction_trigger`); budget 64k retained |
| `openai.ts` | OpenAI remote compact V1/V2 + generic `{systemPrompt,prompt}` POST; 180s timeout |
| `branch-summarization.ts` | Branch summaries from session entries |
| `entries.ts` | `SessionEntry` — message/compaction/branchSummary union; `firstKeptEntryId` |
| `messages.ts` | Compaction/branch message models; `CompactionSummaryMessage.blocks` (text+image archive) |
| `pruning.ts`, `shake.ts` | Mechanical context reducers (drop tool output, replace big blocks) |
| `utils.ts` | `serializeConversation` → transcript text for summary input; strips URLs; drops useless tool results |
| `message-cache.ts` | Dual option-split token estimate cache |
| `errors.ts` | `CompactionCancelledError`, `NativeCompactionError` |

Compaction modes: provider-native remote (Anthropic/OpenAI/Codex), generic
remote summarizer POST, local snapcompact archive, local LLM summarization,
mechanical shake/prune. `success` order is configurable.

## snapcompact (`packages/snapcompact`)

- `src/snapcompact.ts` + `index.ts` — `compact()`, `renderMany()`, `frames()`,
  `resolveShape()`, `serializeConversation()`, `normalize()`, `createFileOps()`
- Deterministic: NO LLM call, no API key; rasterizes text to PNG frames read by
  vision models
- `resolveShape({api,id})` — provider-aware frame shape (Anthropic `11on16-bw`,
  Google/OpenAI `8on22-bw`); model-id matched so gateway-routed Claude keeps its shape
- Rasterization native in `@oh-my-pi/pi-natives`; requires Bun ≥1.3.14
- `test/snapcompact.test.ts`, `research/*.py` (SQuAD recall evals, pricing vizs)

## Model/providers (`packages/ai`)

- Unified provider layer: Anthropic (incl. subscription/agent.db OAuth), OpenAI,
  OpenRouter, custom openai-completions compat (llama.cpp, runinfra), local
- Model discovery/config: provider blocks define baseUrl, api flavor, apiKey,
  modelIds, contextWindow, maxTokens, cost
- `compat.openRouterRouting.order` — OpenRouter upstream pinning (coreweave etc.)
- Retry: `retry.fallbackChains` hop providers on failure/429

## coding-agent (`packages/coding-agent/src`)

- `cli.ts` / `cli-commands.ts` — command surface incl. `/compact`, `/handoff`
- `tools/` — bash, eval, edit, read, write, approval enforcement
- `extensibility/` — extensions, wrapper gating
- `session/`, `subprocess/`, `mcp/`, `lsp/`, `config.ts`, `system-prompt.ts`
- Auto-thinking: `auto-thinking/`
- Advisor: `advisor/`

## Test authority

- `packages/agent/test` and repo `test/` are authoritative for intended behavior
- E.g. `test/tools/approval.test.ts` (bash.patterns first-match), `approval-mode.test.ts`

## Build/ops

- `bun.lock`, `package.json` scripts; `crates/` + `MODULE.bazel` for Rust
- Binary: `/opt/homebrew/bin/omp` (minified — do not `strings` it)
- Docs: `docs/approval-mode.md`, `docs/bash-tool-runtime.md`, `docs/settings.md`,
  `docs/compaction.md`
