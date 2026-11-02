import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { evalSpawnCommand } from "@oh-my-pi/pi-coding-agent/eval/spawn-gate";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Contract: a judged eval spawn reaches extension `tool_call` handlers exactly
 * as a direct bash call does — tool name `bash`, input `{ command, cwd }` — so a
 * bash classifier plugin judges it unchanged, and nothing executes.
 */
describe("ExtensionToolWrapper.authorize (eval spawn judge)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let runner: ExtensionRunner;
	const executed: unknown[] = [];
	const events = (): unknown[] => JSON.parse(fs.readFileSync(path.join(tempDir.path(), "events.json"), "utf8"));

	beforeAll(async () => {
		tempDir = TempDir.createSync("@omp-spawn-authorize-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const log = JSON.stringify(path.join(tempDir.path(), "events.json"));
		const extensionPath = path.join(tempDir.path(), "judge.ts");
		// A stand-in for a bash classifier: records every tool_call, blocks `rm`,
		// and rewrites `rewrite-me` (which a judge-only call must refuse).
		fs.writeFileSync(
			extensionPath,
			`import * as fs from "node:fs";
			const seen = [];
			export default function (pi) {
				pi.on("tool_call", event => {
					seen.push({ toolName: event.toolName, input: event.input });
					fs.writeFileSync(${log}, JSON.stringify(seen));
					if (event.input.command.startsWith("rm ")) return { block: true, reason: "classifier: destructive" };
					if (event.input.command === "rewrite-me") return { input: { ...event.input, command: "echo safe" } };
				});
			}`,
		);
		const loaded = await loadExtensions([extensionPath], tempDir.path());
		runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			new ModelRegistry(authStorage),
		);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	const bash = () =>
		new ExtensionToolWrapper(
			{
				name: "bash",
				label: "Bash",
				description: "Stand-in bash tool; must never run during a judge-only call.",
				parameters: Type.Object({ command: Type.String(), cwd: Type.Optional(Type.String()) }),
				approval: "read",
				execute: async (_id, params) => {
					executed.push(params);
					return { content: [{ type: "text", text: "ran" }] };
				},
			},
			runner,
		);

	it("presents the spawn to tool_call handlers as a bash call and runs nothing", async () => {
		await bash().authorize("eval-spawn-1", { command: "touch /tmp/x", cwd: "/work" });
		expect(events()).toContainEqual({ toolName: "bash", input: { command: "touch /tmp/x", cwd: "/work" } });
		expect(executed).toEqual([]);
	});

	it("rejects with the handler's reason when a handler blocks", async () => {
		await expect(bash().authorize("eval-spawn-2", { command: "rm -rf /work", cwd: "/work" })).rejects.toThrow(
			"classifier: destructive",
		);
		expect(executed).toEqual([]);
	});

	it("refuses when a handler revises the input, since the kernel can only run what it asked about", async () => {
		await expect(bash().authorize("eval-spawn-3", { command: "rewrite-me", cwd: "/work" })).rejects.toThrow(
			"judge-only call cannot run a different input",
		);
		expect(executed).toEqual([]);
	});
});

describe("evalSpawnCommand", () => {
	it("judges a shell form as its script and quotes any other argv so it runs the same words", () => {
		expect(evalSpawnCommand({ argv: ["/bin/sh", "-c", "rm -rf build && make"] })).toBe("rm -rf build && make");
		expect(evalSpawnCommand({ argv: ["touch", "a b", "it's", "$HOME"] })).toBe(`touch 'a b' 'it'\\''s' '$HOME'`);
		expect(evalSpawnCommand({ argv: ["sh", "-c", "echo $0", "arg0"] })).toBe(`sh -c 'echo $0' arg0`);
	});
});
