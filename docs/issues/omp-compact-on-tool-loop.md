# omp: steer, then compact, then abort when the model repeats one tool call

Status: open. Written 2026-09-30 after a design review with Sam. Repo: `~/git/forks/omp`
(branch `sync-fork-main`, remote `can1357/oh-my-pi`). Package: `packages/coding-agent`.

Read `~/git/forks/omp/AGENTS.md` first. Rules from it that bite here: no `any`, no inline
imports, `#private` fields with no `private` keyword, no prompts built from strings in code,
`Promise.withResolvers()` over `new Promise`. Do NOT push, open a PR, or post anywhere. Commit
locally on a new branch `feat/compact-on-tool-loop` cut from the current HEAD, and stop.

## Problem

omp already detects "the same tool call N turns in a row" and injects a hidden redirect message
(`session/stream-guards.ts`, class `LoopGuards`). The detector keeps counting after it fires, so
when the model ignores the redirect, every further identical turn injects the same redirect
again, forever. The repeated failing calls and their results stay in context and keep the model
repeating them. We want a ladder: steer first, compact if the steer is ignored, abort as the
last resort.

Scope: ONLY the primary session's tool-call loop guard. Do not touch the thinking-loop guard
(`packages/ai/src/utils/thinking-loop.ts`, `session/turn-recovery.ts`) or the advisor's guard
(`advisor/loop-guard.ts`).

## Behavior to build

New setting `model.toolCallLoopGuard.compactAfter` (number, default `0`). Let `T` be the existing
`model.toolCallLoopGuard.threshold` (default 5), `K` be `compactAfter`, and `count` be
`detection.count` from `ToolCallLoopGuard.recordTurn` (identical turns in a row).

| count            | K = 0 (default)              | K > 0                                                        |
|------------------|------------------------------|--------------------------------------------------------------|
| below T          | nothing                      | nothing                                                      |
| T up to T+K-1    | redirect (as today)          | redirect (as today)                                          |
| T+K              | redirect (as today)          | compact once, then redirect. If compaction did nothing, redirect only |
| T+K+1 .. T+2K-1  | redirect (as today)          | redirect                                                     |
| T+2K and above   | redirect (as today)          | if this episode already compacted: abort the turn and emit a warning notice. If it never compacted: redirect |

With `K = 0` behavior must be byte-for-byte what it is today. No compaction, no abort.

An "episode" is a run of identical turns. It ends when `recordTurn` returns no detection (the
model made a different call, called only exempt tools, or made no tool call). One compaction per
episode, tracked by a boolean on `LoopGuards` that is cleared on any turn with no detection.
Do NOT reset the `ToolCallLoopGuard` after compacting. Its count must keep climbing so the abort
rung can be reached.

Compaction honors the user's existing compaction setup: it does nothing when
`compaction.enabled` is false or no compaction method is configured. That is intended. The
compaction summarizer cannot take custom instructions on this path, so the "do not repeat this
call" note rides in the redirect message that is injected right after compaction. The existing
`renderToolCallLoopRedirect(detection)` already includes tool name, argument summary and result
summary. Do not change that template.

## Files to change, in order

All paths are under `packages/coding-agent/`.

1. `src/session/settings.ts`. Directly after `cfgModelToolCallLoopGuardThreshold` (around line
   310) add `cfgModelToolCallLoopGuardCompactAfter`, copying that block's shape: `id:
   "model.toolCallLoopGuard.compactAfter"`, `type: "number"`, `default: 0`, same `ui.tab` and
   `ui.group`, `label: "Tool-Call Loop Compact After"`, description: "Extra identical tool calls,
   beyond the threshold, before the session is compacted (0 turns this off). Twice this many
   triggers an abort". `docs/settings.md` lists settings by prefix only, so it needs no edit.

2. `src/session/stream-guards.ts`. Three edits.

   a. Add a pure exported function above `LoopGuards`:

      ```ts
      export type ToolLoopRung = "steer" | "compact" | "abort";
      export function toolLoopRung(
      	count: number,
      	threshold: number,
      	compactAfter: number,
      	compactedThisEpisode: boolean,
      ): ToolLoopRung
      ```

      Implement exactly the table above. `compactAfter <= 0` returns `"steer"`. Otherwise:
      `count >= threshold + 2 * compactAfter && compactedThisEpisode` is `"abort"`;
      `count === threshold + compactAfter && !compactedThisEpisode` is `"compact"`; everything
      else is `"steer"`.

   b. Add to `StreamGuardsHost` one member:
      `compactForToolLoop(messages: AgentMessage[], signal: AbortSignal | undefined, context: AgentTurnEndContext | undefined): Promise<boolean>;`
      It returns true when history was actually rewritten.

   c. In `LoopGuards`: add `#compactedThisEpisode = false`. Change `recordTurn` to
      `async recordTurn(...): Promise<void>` taking the same arguments plus `signal:
      AbortSignal | undefined`. Logic: if no detection, set `#compactedThisEpisode = false` and
      return. Otherwise compute `rung = toolLoopRung(detection.count, threshold, compactAfter,
      this.#compactedThisEpisode)` (read `compactAfter` with
      `cfgModelToolCallLoopGuardCompactAfter.get(this.#host.settings)`). Then:
      - `"abort"`: `logger.warn(...)`, `this.#host.emitNotice("warning", "Stopped: <toolName>
        was called <count> times in a row, even after compacting context.", "loop-guard")`, then
        `this.#host.agent.abort("Stopped by tool-call loop guard")`. Do not inject a redirect.
      - `"compact"`: `const rewritten = await this.#host.compactForToolLoop(messages, signal,
        context)`; set `this.#compactedThisEpisode = rewritten`; then inject the redirect with
        the existing `#injectToolCallLoopRedirect(messages, detection)`.
      - `"steer"`: inject the redirect, as today.
      Keep the method flat (guard clauses or a small lookup, no deep nesting): a complexity
      lint runs on this repo.

3. `src/session/session-maintenance.ts`. Add a public method next to `maintainContextMidRun`
   (which starts around line 2575). Name: `compactForToolLoop(activeMessages: AgentMessage[],
   signal: AbortSignal | undefined, context: AgentTurnEndContext | undefined):
   Promise<boolean>`. Copy the tail of `maintainContextMidRun` (the code from
   `const messagesBefore = activeMessages.length;` to the `activeMessages.splice(...)`), not its
   threshold checks. Required steps, in this order:
   - Return false if `signal?.aborted`, `this.#host.isDisposed()`, `this.isCompacting`,
     `this.#host.isGeneratingHandoff()`, or `!context?.willContinue`.
   - `if (!(await this.#host.persistTurnMessagesForMidRunCompaction(context))) return false;`
     then re-check `signal?.aborted || this.#host.isDisposed()` and return false.
   - `const result = await this.runAutoCompaction("threshold", false, false, false, {
     autoContinue: false, suppressContinuation: true, phase: "mid_turn", detachPostCommit: true
     });`
   - `if (signal?.aborted) return false;`
   - Copy the splice: if `this.#host.agent.state.messages !== activeMessages`, run
     `activeMessages.splice(0, activeMessages.length, ...compactedMessages)` and
     `invalidateConvertToLlmArrayCache(activeMessages)`.
   - Return `result.historyRewritten === true`. If that field is undefined in a success case,
     fall back to comparing: return true when the spliced array differs from the array before
     (compare lengths and first element identity). Read how `historyRewritten` is set before
     choosing; do not guess.
   Do NOT call `promoteContextModel`, `shouldCompact`, or the dead-end set: this path forces
   compaction regardless of token count.

4. `src/session/agent-session.ts`.
   - In the `streamGuardsHost` object (around line 1935) add
     `compactForToolLoop: (messages, signal, context) => this.#maintenance.compactForToolLoop(messages, signal, context),`
     (match how neighbouring members reach `#maintenance`).
   - In `setOnTurnEnd` (around line 1764) change
     `this.#loopGuards.recordTurn(messages, context);` to
     `await this.#loopGuards.recordTurn(messages, context, signal);`.

5. `packages/coding-agent/CHANGELOG.md`. Under `## [Unreleased]` then `### Added`, one line:
   "Setting `model.toolCallLoopGuard.compactAfter` compacts the session when the model keeps
   repeating a tool call after the redirect, and stops the turn if it still loops (off by
   default)". Read AGENTS.md's Changelog section; no issue link, none exists.

## Tests, write them FIRST and watch them fail

Create `test/agent-session-tool-call-loop-compact.test.ts`. Two parts.

Part A, pure unit tests of `toolLoopRung` imported from
`@oh-my-pi/pi-coding-agent/session/stream-guards` (same alias style as the other tests). With
`threshold = 2`, `compactAfter = 1`:
- count 1 with compacted false: `"steer"` (callers do not call it below threshold, but the table says steer)
- count 2, false: `"steer"`
- count 3, false: `"compact"`
- count 3, true: `"steer"`
- count 4, true: `"abort"`
- count 4, false: `"steer"`
- `compactAfter = 0`, counts 2 through 9, both flags: always `"steer"`

Part B, session-level tests. Copy the harness from
`test/agent-session-mid-turn-compaction-dead-end.test.ts` (its `createSession`, the `noop` tool,
and the `session_before_compact` extension short-circuit so no summarizer LLM call is made) and
the settings from `test/agent-session-tool-call-loop-guard.test.ts`. Settings for every case:
`"model.toolCallLoopGuard.enabled": true`, `"model.toolCallLoopGuard.threshold": 2`,
`"compaction.enabled": true`, `"compaction.methodOrder": ["soft"]`,
`"compaction.midTurnEnabled": true`, `"compaction.autoContinue": false`,
`"retry.enabled": false`, `"todo.enabled": false`, plus `compactAfter` per case. Script the mock
model to emit a `noop` tool call with identical arguments on every turn (give each call a
unique id), then a plain text stop if it is ever reached. Give the session a few earlier user
and assistant turns first so `prepareCompaction` has something to cut; the dead-end test shows
how a viable compaction is set up. Count `auto_compaction_start` events and `notice` events with
`session.subscribe`, as that test does. Cases:

1. `compactAfter: 1`, six identical turns scripted. Assert exactly one `auto_compaction_start`,
   a "tool-call-loop-redirect" custom message exists after the compaction entry, and the fifth
   model call never happens (abort at count 4 = T+2K). Assert a notice with source
   `"loop-guard"` was emitted.
2. `compactAfter: 0`, six identical turns then a text stop. Assert zero `auto_compaction_start`
   events, no loop-guard abort notice, and the run reaches the text stop.
3. `compactAfter: 1`, sequence A A A B B B then a text stop (A and B are two different
   argument objects). Assert two `auto_compaction_start` events (one per episode) and no abort.
4. `compactAfter: 1` with `"compaction.enabled": false`, three identical turns. Assert zero
   compactions and that the loop reaches the abort rung only if `compacted` was true: since
   nothing compacted it must NOT abort, it keeps steering. Script a text stop at turn 6 and
   assert the run reaches it.

If a case needs token usage on the mock responses for compaction to be viable, set
`usage: { input: 190_000 }` as the dead-end test does.

## Verify

Run from `~/git/forks/omp/packages/coding-agent`:

```
bun test test/agent-session-tool-call-loop-compact.test.ts
bun test test/agent-session-tool-call-loop-guard.test.ts test/advisor-tool-call-loop-guard.test.ts
bun test test/agent-session-mid-turn-compaction-dead-end.test.ts
bun run check
```

All must pass. Paste the last 15 lines of each in your report. If `bun run check` fails on a
file you did not touch, say which file and stop; do not fix it.

## Done means

- New test file written first and seen failing, then passing.
- The three existing test files above still pass unchanged.
- One local commit on `feat/compact-on-tool-loop`, message
  `feat: compact then abort when a tool call keeps repeating after the redirect`.
- No push, no PR, no GitHub comment.

## If you get stuck

- `runAutoCompaction` returns `COMPACTION_CHECK_NONE` (no rewrite) when `compaction.enabled` is
  false, when no method is configured, or when `prepareCompaction` finds nothing to cut. That
  is the "compaction did nothing" path and it must fall through to a plain redirect.
- If a session test hangs, the usual cause is a mock model that runs out of scripted responses.
  Script one more text-stop response at the end.
- Report anything in this file that does not match the code instead of improvising. Line
  numbers above were read on 2026-09-30 and may drift by a few lines.
