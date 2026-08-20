import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_SETTINGS_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "reload-settings",
		aliases: ["reload-config"],
		description: "Re-read config.yml (and project/overlay settings) from disk and apply them without a restart",
		acpDescription: "Reload settings from disk",
		handle: async (_command, runtime) => {
			const before = new Map<SettingPath, unknown>();
			for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
				before.set(key, runtime.settings.get(key));
			}
			await runtime.settings.reloadFromDisk();
			await runtime.notifyConfigChanged?.();

			const changed: SettingPath[] = [];
			for (const [key, previous] of before) {
				if (!Bun.deepEquals(previous, runtime.settings.get(key))) {
					changed.push(key);
				}
			}
			if (changed.length === 0) {
				await runtime.output("Settings reloaded from disk. No effective values changed.");
				return;
			}
			await runtime.output(`Settings reloaded from disk. Applied: ${changed.join(", ")}`);
		},
	},
];
