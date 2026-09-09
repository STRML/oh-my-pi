import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { setTerminalTextSizing, TERMINAL } from "@oh-my-pi/pi-tui";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	applySessionSettingSideEffects,
	applySettingSideEffects,
	REPLAYED_SETTING_IDS,
	replaySessionSettingSideEffects,
	snapshotReplaySettings,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/setting-side-effects";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	getTerminalTitleStateEnabled,
	setTerminalTitleStateEnabled,
} from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { logger, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../../src/session/agent-session";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

describe("applySettingSideEffects replay coverage", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-setting-side-effects-");
		setAgentDir(tempDir.path());
		await Settings.init({ agentDir: tempDir.path(), inMemory: true });
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	it("allowlists every cached value this suite pins a replay path for", () => {
		// The replay loop only visits allowlisted ids; an id missing here keeps
		// the matching consumer cache stale after /reload-settings.
		for (const id of [
			"compaction.enabled",
			"showHardwareCursor",
			"tui.textSizing",
			"tui.titleState",
			"statusLine.leftSegments",
			"statusLine.rightSegments",
			"statusLine.segmentOptions",
		] as const) {
			expect(REPLAYED_SETTING_IDS).toContain(id);
		}
	});

	it("replays compaction.enabled into the status line's cached auto-compact flag", () => {
		const setAutoCompactEnabled = vi.fn();
		// The status line caches the session's effective flag (enabled AND a
		// resolvable method order), not the raw setting value: `true` with no
		// configured method must still read as off.
		const ctx = {
			session: { autoCompactionEnabled: false },
			statusLine: { setAutoCompactEnabled },
		} as unknown as InteractiveModeContext;

		applySettingSideEffects(ctx, "compaction.enabled", true, { persist: false });

		expect(setAutoCompactEnabled).toHaveBeenCalledWith(false);
	});

	it("replays statusLine segment keys through the shared status line apply", () => {
		settings.set("statusLine.leftSegments", ["model"]);
		settings.set("statusLine.rightSegments", ["token_total"]);
		settings.set("statusLine.segmentOptions", { model: { showSpeed: true } });

		const updates: Record<string, unknown>[] = [];
		const ctx = {
			statusLine: { updateSettings: (next: Record<string, unknown>) => updates.push(next) },
			ui: { requestRender: () => {} },
		} as unknown as InteractiveModeContext;

		for (const id of ["statusLine.leftSegments", "statusLine.rightSegments", "statusLine.segmentOptions"]) {
			applySettingSideEffects(ctx, id, settings.get(id as never), { persist: false });
		}

		expect(updates).toHaveLength(3);
		expect(updates[2]).toMatchObject({
			leftSegments: ["model"],
			rightSegments: ["token_total"],
			segmentOptions: { model: { showSpeed: true } },
		});
	});

	it("replays showHardwareCursor into the TUI cursor mode and editor glyph mode", () => {
		const setShowHardwareCursor = vi.fn();
		const editorCursorModes: boolean[] = [];
		const ctx = {
			ui: {
				setShowHardwareCursor,
				getShowHardwareCursor: () => false,
			},
			editor: { setUseTerminalCursor: (use: boolean) => editorCursorModes.push(use) },
		} as unknown as InteractiveModeContext;

		applySettingSideEffects(ctx, "showHardwareCursor", false, { persist: false });

		expect(setShowHardwareCursor).toHaveBeenCalledWith(false);
		expect(editorCursorModes).toEqual([false]);
	});

	it("replays tui.textSizing gated on the terminal's text-sizing capability", () => {
		const capability = TERMINAL as unknown as { supportsTextSizing: boolean };
		const originalCapability = capability.supportsTextSizing;
		const originalSizing = TERMINAL.textSizing;
		capability.supportsTextSizing = true;
		try {
			const ctx = { ui: { invalidate: () => {}, requestRender: () => {} } } as unknown as InteractiveModeContext;

			applySettingSideEffects(ctx, "tui.textSizing", true, { persist: false });
			expect(TERMINAL.textSizing).toBe(true);

			applySettingSideEffects(ctx, "tui.textSizing", false, { persist: false });
			expect(TERMINAL.textSizing).toBe(false);
		} finally {
			capability.supportsTextSizing = originalCapability;
			setTerminalTextSizing(originalSizing);
		}
	});

	it("replays tui.titleState into the terminal title run-state gate", () => {
		const ctx = {} as unknown as InteractiveModeContext;
		setTerminalTitleStateEnabled(true);
		try {
			applySettingSideEffects(ctx, "tui.titleState", false, { persist: false });
			expect(getTerminalTitleStateEnabled()).toBe(false);

			applySettingSideEffects(ctx, "tui.titleState", true, { persist: false });
			expect(getTerminalTitleStateEnabled()).toBe(true);
		} finally {
			setTerminalTitleStateEnabled(true);
		}
	});

	it("routes session-level apply failures to showError in interactive mode", async () => {
		const refreshBaseSystemPrompt = vi.fn(async () => {
			throw new Error("boom");
		});
		const showError = vi.fn();
		const ctx = { session: { refreshBaseSystemPrompt }, showError } as unknown as InteractiveModeContext;

		applySettingSideEffects(ctx, "personality", "concise");
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(showError).toHaveBeenCalledWith("Failed to apply personality: Error: boom");
	});
});

describe("replaySessionSettingSideEffects", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-setting-side-effects-");
		setAgentDir(tempDir.path());
		await Settings.init({ agentDir: tempDir.path(), inMemory: true });
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	function stubSession(overrides: Record<string, unknown> = {}): AgentSession {
		return {
			settings,
			setThinkingLevel: () => {},
			refreshBaseSystemPrompt: async () => {},
			applyMemoryBackend: async () => {},
			setThinkToolEnabled: async () => true,
			...overrides,
		} as unknown as AgentSession;
	}

	it("applies session-level settings with persist=false and ignores TUI-only ids", async () => {
		const thinkingLevels: Array<{ level: unknown; persist: boolean }> = [];
		const thinkToolStates: boolean[] = [];
		const session = stubSession({
			setThinkingLevel: (level: unknown, persist: boolean) => thinkingLevels.push({ level, persist }),
			setThinkToolEnabled: async (enabled: boolean) => {
				thinkToolStates.push(enabled);
				return true;
			},
		});
		const beforeReplay = snapshotReplaySettings(settings);
		settings.set("defaultThinkingLevel", Effort.Low);
		settings.set("externalThinking", true);

		// The full allowlist is diffed: session-level ids whose value changed
		// apply, every pure TUI id (autocompleteMaxVisible, statusLine.*, …) is
		// skipped without needing any interactive-mode context.
		await replaySessionSettingSideEffects(session, beforeReplay);

		expect(thinkingLevels).toEqual([{ level: "low", persist: false }]);
		expect(thinkToolStates).toEqual([true]);
	});

	it("skips unchanged ids so a session-only thinking level survives a no-op reload", async () => {
		settings.set("defaultThinkingLevel", Effort.Low);
		const beforeReplay = snapshotReplaySettings(settings);
		const thinkingLevels: Array<{ level: unknown; persist: boolean }> = [];
		const session = stubSession({
			setThinkingLevel: (level: unknown, persist: boolean) => thinkingLevels.push({ level, persist }),
		});

		// Nothing changed since the snapshot: replaying would clobber the
		// session-only override (Shift+Tab) with the unchanged disk default.
		await replaySessionSettingSideEffects(session, beforeReplay);

		expect(thinkingLevels).toEqual([]);
	});

	it("logs apply failures through the logger when no error sink is supplied", async () => {
		const session = stubSession({
			setThinkToolEnabled: async () => {
				throw new Error("boom");
			},
		});
		const beforeReplay = snapshotReplaySettings(settings);
		settings.set("externalThinking", true);
		const warnings: string[] = [];
		const warn = spyOn(logger, "warn").mockImplementation((...parts: unknown[]) => {
			warnings.push(parts.map(String).join(" "));
		});

		try {
			await replaySessionSettingSideEffects(session, beforeReplay);
		} finally {
			warn.mockRestore();
		}

		expect(warnings.some(w => w.includes("Failed to apply external thinking: Error: boom"))).toBe(true);
	});

	it("applies memory.backend through the session's backend reconciler", async () => {
		let applied = 0;
		const session = stubSession({
			applyMemoryBackend: async () => {
				applied++;
			},
		});
		const beforeReplay = snapshotReplaySettings(settings);
		settings.set("memory.backend", "local");

		await replaySessionSettingSideEffects(session, beforeReplay);

		expect(applied).toBe(1);
	});

	it("resolves only after every replayed session mutation settles", async () => {
		let releaseThinkTool!: (enabled: boolean) => void;
		const thinkToolGate = new Promise<boolean>(resolve => {
			releaseThinkTool = resolve;
		});
		let releaseMemoryBackend!: () => void;
		const memoryGate = new Promise<void>(resolve => {
			releaseMemoryBackend = resolve;
		});
		let thinkSettled = false;
		let memorySettled = false;
		let replaySettled = false;
		const session = stubSession({
			setThinkToolEnabled: async () => {
				await thinkToolGate;
				thinkSettled = true;
				return true;
			},
			applyMemoryBackend: async () => {
				await memoryGate;
				memorySettled = true;
			},
		});
		const beforeReplay = snapshotReplaySettings(settings);
		settings.set("externalThinking", true);
		settings.set("memory.backend", "local");

		const replayed = replaySessionSettingSideEffects(session, beforeReplay);
		void replayed.then(() => {
			replaySettled = true;
		});

		// Deterministic gates, no wall-clock sleep: while both mutations are in
		// flight the replay must still be pending — a fire-and-forget replay
		// would have resolved here and let the host acknowledge the reload
		// before the tool set / backend actually changed.
		await Promise.resolve();
		expect(thinkSettled).toBe(false);
		expect(memorySettled).toBe(false);
		expect(replaySettled).toBe(false);

		// Settling one mutation must not settle the replay: every replayed
		// apply has to land first.
		releaseMemoryBackend();
		await Promise.resolve();
		expect(memorySettled).toBe(true);
		expect(replaySettled).toBe(false);

		releaseThinkTool(true);
		await replayed;
		expect(thinkSettled).toBe(true);
		expect(replaySettled).toBe(true);
	});

	it("applies one session-level setting on demand for the selector path", async () => {
		const prompts: number[] = [];
		const session = stubSession({
			refreshBaseSystemPrompt: async () => {
				prompts.push(1);
			},
		});

		applySessionSettingSideEffects(session, "tools.xdevDocs", "catalog");

		await Promise.resolve();
		await Promise.resolve();
		expect(prompts).toEqual([1]);
	});
});
