import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { emitRpcConfigUpdate } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../src/session/agent-session";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("emitRpcConfigUpdate", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-rpc-config-update-");
		setAgentDir(tempDir.path());
		await Settings.init({ agentDir: tempDir.path(), inMemory: true });
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	it("replays session settings before emitting the config_update frame", () => {
		const order: string[] = [];
		const session = {
			settings,
			setThinkingLevel: () => {},
			refreshBaseSystemPrompt: async () => {
				order.push("prompt");
			},
			applyMemoryBackend: async () => {
				order.push("memory");
			},
			setThinkToolEnabled: async (enabled: boolean) => {
				order.push(`think:${enabled}`);
				return true;
			},
			model: { provider: "anthropic", id: "claude" },
			thinkingLevel: "high",
		} as unknown as AgentSession;
		settings.set("externalThinking", true);
		settings.set("memory.backend", "local");

		const frames: object[] = [];
		emitRpcConfigUpdate(session, obj => {
			order.push("frame");
			frames.push(obj);
		});

		// The replay of every session-level setting precedes the host update.
		expect(order[order.length - 1]).toBe("frame");
		expect(order.filter(entry => entry.startsWith("think:"))).toEqual(["think:true"]);
		expect(order.filter(entry => entry === "memory")).toEqual(["memory"]);
		expect(frames).toEqual([
			{ type: "config_update", model: { provider: "anthropic", id: "claude" }, thinkingLevel: "high" },
		]);
	});
});
