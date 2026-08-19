import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("/reload-settings slash command", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-reload-settings-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCustomApis();
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	const configPath = () => path.join(agentDir, "config.yml");
	const writeSettings = (settings: Record<string, unknown>) =>
		Bun.write(configPath(), YAML.stringify(settings, null, 2));

	async function runCommand(
		settings: Settings,
	): Promise<{ output: ReturnType<typeof vi.fn>; notifyConfigChanged: ReturnType<typeof vi.fn> }> {
		const command = lookupBuiltinSlashCommand("reload-settings");
		expect(command).toBeDefined();
		const output = vi.fn();
		const notifyConfigChanged = vi.fn();
		const runtime = {
			session: undefined,
			sessionManager: undefined,
			settings,
			cwd: projectDir,
			output,
			refreshCommands: async () => {},
			reloadPlugins: async () => {},
			notifyConfigChanged,
		} as unknown as SlashCommandRuntime;
		await command!.handle?.({ name: "reload-settings", args: "", text: "/reload-settings" }, runtime);
		return { output, notifyConfigChanged };
	}

	it("applies an on-disk edit and reports the changed setting", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.get("advisor.syncBacklog")).toBe("1");

		await writeSettings({ advisor: { syncBacklog: "3" } });
		const { output, notifyConfigChanged } = await runCommand(settings);

		expect(settings.get("advisor.syncBacklog")).toBe("3");
		expect(output).toHaveBeenCalledWith(expect.stringContaining("advisor.syncBacklog"));
		expect(notifyConfigChanged).toHaveBeenCalled();
	});

	it("reports when nothing effectively changed", async () => {
		await writeSettings({ advisor: { syncBacklog: "1" } });
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		const { output } = await runCommand(settings);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("No effective values changed"));
	});
});
