import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { MemoryBackend, MemoryBackendStartOptions } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { withSharpshooter } from "@oh-my-pi/pi-coding-agent/memory-backend/with-sharpshooter";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { sharpshooterBackend } from "@oh-my-pi/pi-coding-agent/sharpshooter/backend";
import { sharpshooterBankDir } from "@oh-my-pi/pi-coding-agent/sharpshooter/paths";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(name: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	tempDirs.push(dir);
	return dir;
}

/** A store backend that records what the wrapper asked of it. */
function stubPrimary(calls: string[]): MemoryBackend {
	return {
		id: "mnemopi",
		start: () => {
			calls.push("start");
		},
		buildDeveloperInstructions: async () => "PRIMARY INSTRUCTIONS",
		clear: async () => {
			calls.push("clear");
		},
		enqueue: async () => {
			calls.push("enqueue");
		},
		status: async () => ({ backend: "mnemopi" as const, active: true, writable: true, searchable: true, message: "primary status" }),
		search: async (_context, query) => ({ backend: "mnemopi" as const, query, count: 1, items: [{ content: "primary hit" }] }),
		save: async () => ({ backend: "mnemopi" as const, stored: 1 }),
		beforeAgentStartPrompt: async () => "PRIMARY TURN PROMPT",
		preCompactionContext: async () => "PRIMARY COMPACTION",
	};
}

describe("sharpshooter paired with a store backend", () => {
	it("leaves the backend alone when the flag is off", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi" });
		expect(await resolveMemoryBackend(settings)).toBe(mnemopiBackend);
	});

	it("wraps the selected backend when the flag is on", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemopi", "sharpshooter.enabled": true });
		const resolved = await resolveMemoryBackend(settings);
		expect(resolved).not.toBe(mnemopiBackend);
		// Tool gating reads memory.backend, and the id must keep agreeing with it.
		expect(resolved.id).toBe("mnemopi");
	});

	it("never wraps sharpshooter around itself", async () => {
		const settings = Settings.isolated({ "memory.backend": "sharpshooter", "sharpshooter.enabled": true });
		expect(await resolveMemoryBackend(settings)).toBe(sharpshooterBackend);
	});

	it("pairs with the off backend without turning memory tools on", async () => {
		const settings = Settings.isolated({ "memory.backend": "off", "sharpshooter.enabled": true });
		const resolved = await resolveMemoryBackend(settings);
		expect(resolved.id).toBe("off");
	});

	it("injects both backends' instructions", async () => {
		const root = await makeTempDir("sharpshooter-pairing");
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const settings = Settings.isolated({ "memory.backend": "mnemopi", "sharpshooter.enabled": true });
		await settings.reloadForCwd(cwd);
		const bankDir = sharpshooterBankDir(agentDir, cwd);
		await fs.mkdir(bankDir, { recursive: true });
		await Bun.write(path.join(bankDir, "architecture.md"), "- Keep storage project-scoped.\n");

		const paired = withSharpshooter(stubPrimary([]));
		const instructions = await paired.buildDeveloperInstructions(agentDir, settings);
		expect(instructions).toContain("PRIMARY INSTRUCTIONS");
		expect(instructions).toContain("Keep storage project-scoped.");
	});

	it("starts, clears and enqueues both backends", async () => {
		const calls: string[] = [];
		const start = spyOn(sharpshooterBackend, "start").mockImplementation(() => {
			calls.push("sharpshooter start");
		});
		const clear = spyOn(sharpshooterBackend, "clear").mockImplementation(async () => {
			calls.push("sharpshooter clear");
		});
		const enqueue = spyOn(sharpshooterBackend, "enqueue").mockImplementation(async () => {
			calls.push("sharpshooter enqueue");
		});
		const paired = withSharpshooter(stubPrimary(calls));
		paired.start({} as MemoryBackendStartOptions);
		await paired.clear("/agent", "/cwd");
		await paired.enqueue("/agent", "/cwd");
		// start is fire-and-forget, so let its microtasks settle before asserting.
		await Promise.resolve();
		expect(calls).toContain("start");
		expect(calls).toContain("sharpshooter start");
		expect(calls).toContain("clear");
		expect(calls).toContain("sharpshooter clear");
		expect(calls).toContain("enqueue");
		expect(calls).toContain("sharpshooter enqueue");
		expect(start).toHaveBeenCalled();
		expect(clear).toHaveBeenCalled();
		expect(enqueue).toHaveBeenCalled();
	});

	it("keeps the primary's turn prompt, save and compaction hooks", async () => {
		const paired = withSharpshooter(stubPrimary([]));
		await expect(paired.beforeAgentStartPrompt?.({} as never, "prompt")).resolves.toBe("PRIMARY TURN PROMPT");
		await expect(paired.preCompactionContext?.([], {} as never)).resolves.toBe("PRIMARY COMPACTION");
		await expect(paired.save?.({ agentDir: "/agent", cwd: "/cwd" }, { content: "note" })).resolves.toMatchObject({ stored: 1 });
	});

	it("merges search hits from both backends", async () => {
		spyOn(sharpshooterBackend, "search").mockResolvedValue({
			backend: "sharpshooter",
			query: "deploy",
			count: 1,
			items: [{ content: "- Deploy through the script.", source: "architecture.md" }],
		});
		const paired = withSharpshooter(stubPrimary([]));
		const result = await paired.search?.({ agentDir: "/agent", cwd: "/cwd" }, "deploy");
		expect(result?.backend).toBe("mnemopi");
		expect(result?.count).toBe(2);
		expect(result?.items.map(item => item.content)).toEqual(["primary hit", "- Deploy through the script."]);
	});

	it("reports both backends in status", async () => {
		spyOn(sharpshooterBackend, "status").mockResolvedValue({
			backend: "sharpshooter",
			active: true,
			writable: false,
			searchable: true,
			message: "architecture.md: 3 lines",
		});
		const paired = withSharpshooter(stubPrimary([]));
		const status = await paired.status?.({ agentDir: "/agent", cwd: "/cwd" });
		expect(status?.backend).toBe("mnemopi");
		expect(status?.message).toContain("primary status");
		expect(status?.message).toContain("sharpshooter — architecture.md: 3 lines");
	});

	it("keeps the primary working when the paired backend throws", async () => {
		spyOn(sharpshooterBackend, "buildDeveloperInstructions").mockRejectedValue(new Error("sharpshooter is broken"));
		spyOn(sharpshooterBackend, "clear").mockRejectedValue(new Error("sharpshooter is broken"));
		const calls: string[] = [];
		const paired = withSharpshooter(stubPrimary(calls));
		await expect(paired.buildDeveloperInstructions("/agent", {} as never)).resolves.toBe("PRIMARY INSTRUCTIONS");
		await paired.clear("/agent", "/cwd");
		expect(calls).toContain("clear");
	});
});
