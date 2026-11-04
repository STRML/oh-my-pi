import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import * as executor from "../src/exec/bash-executor";
import type { ClientBridge } from "../src/session/client-bridge";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";
import * as shellSnapshot from "../src/utils/shell-snapshot";
import { Shell, type ShellRunResult } from "@oh-my-pi/pi-natives";

let cwd: string;
let settings: Settings;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shell-review-"));
	settings = Settings.isolated({ "bash.autoBackground.enabled": false, "bashInterceptor.enabled": false });
	vi.spyOn(Settings, "init").mockResolvedValue(settings);
});

afterEach(async () => {
	executor.releaseShellSessions(cwd);
	vi.restoreAllMocks();
	resetSettingsForTest();
	await fs.rm(cwd, { recursive: true, force: true });
});

function tool(overrides: Partial<ToolSession> = {}): BashTool {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		settings,
		...overrides,
	};
	return new BashTool(session);
}

it("returns unavailable before a session shell has run", async () => {
	expect(await executor.inspectShellSession(cwd, ["echo"])).toBeUndefined();
});

it("does not report the host's initial cwd synchronization as an exported-variable change", async () => {
	await tool().execute("prime", { command: ":" });
	const report = await executor.inspectShellSession(cwd, []);
	expect(report?.exportsChanged).toEqual([]);
});

it.each([{ pty: true }, { async: true }, { name: "reviewed-service" }])(
	"refuses a reviewed command on a non-foreground route: %j",
	async route => {
		await expect(
			tool().execute("review", {
				command: "printf forbidden > marker",
				...route,
				shellState: { state: "0".repeat(64), files: [] },
			}),
		).rejects.toThrow("shellState requires a persistent foreground shell");
		expect(await Bun.file(path.join(cwd, "marker")).exists()).toBe(false);
	},
);

it("rejects malformed review tokens before submitting a command", async () => {
	await expect(
		tool().execute("review", {
			command: "printf forbidden > marker",
			shellState: { state: "bad", files: [] },
		}),
	).rejects.toThrow("Invalid shellState");
	expect(await Bun.file(path.join(cwd, "marker")).exists()).toBe(false);
});

it("turns stale shell state into a tool error without running its command", async () => {
	const bash = tool();
	await bash.execute("prime", { command: ":" });
	const report = await executor.inspectShellSession(cwd, []);
	if (!report) throw new Error("Expected an inspectable shell");
	await bash.execute("change", { command: "REVIEW_CHANGED=1" });
	await expect(
		bash.execute("review", {
			command: "printf forbidden > marker",
			shellState: { state: report.fingerprint, files: [] },
		}),
	).rejects.toThrow("the shell changed after this command was reviewed (shell state changed); run it again");
	expect(await Bun.file(path.join(cwd, "marker")).exists()).toBe(false);
});

it("runs a reviewed command with matching state and file bytes", async () => {
	const bash = tool();
	await bash.execute("prime", { command: ":" });
	const report = await executor.inspectShellSession(cwd, []);
	if (!report) throw new Error("Expected an inspectable shell");
	const reviewed = path.join(cwd, "reviewed");
	await Bun.write(reviewed, "reviewed bytes");
	const sha256 = new Bun.CryptoHasher("sha256").update("reviewed bytes").digest("hex");
	await bash.execute("review", {
		command: "printf allowed > marker",
		shellState: { state: report.fingerprint, files: [{ path: reviewed, sha256 }] },
	});
	expect(await Bun.file(path.join(cwd, "marker")).text()).toBe("allowed");
});

it("rejects changed reviewed file bytes even with matching shell state", async () => {
	const bash = tool();
	await bash.execute("prime", { command: ":" });
	const report = await executor.inspectShellSession(cwd, []);
	if (!report) throw new Error("Expected an inspectable shell");
	const reviewed = path.join(cwd, "reviewed");
	await Bun.write(reviewed, "swapped bytes");
	const sha256 = new Bun.CryptoHasher("sha256").update("reviewed bytes").digest("hex");
	await expect(
		bash.execute("review", {
			command: "printf forbidden > marker",
			shellState: { state: report.fingerprint, files: [{ path: reviewed, sha256 }] },
		}),
	).rejects.toThrow(`the shell changed after this command was reviewed (file changed: ${reviewed}); run it again`);
	expect(await Bun.file(path.join(cwd, "marker")).exists()).toBe(false);
});

it("makes busy inspection unavailable and refuses tokens instead of running a temporary shell", async () => {
	await executor.executeBash(":", { sessionKey: cwd, cwd });
	const report = await executor.inspectShellSession(cwd, []);
	if (!report) throw new Error("Expected an inspectable shell");
	const started = Promise.withResolvers<void>();
	const running = executor.executeBash("sleep 1", { sessionKey: cwd, cwd, onStart: () => started.resolve() });
	try {
		await started.promise;
		expect(await executor.inspectShellSession(cwd, [])).toBeUndefined();
		await expect(
			executor.executeBash("printf forbidden > marker", {
				sessionKey: cwd,
				cwd,
				expect: { state: report.fingerprint, files: [] },
			}),
		).rejects.toThrow("the shell changed after this command was reviewed (shell is busy); run it again");
		expect(await Bun.file(path.join(cwd, "marker")).exists()).toBe(false);
	} finally {
		await running;
	}
});

it("keeps the internal review token out of the model-facing tool schema", () => {
	expect(tool().parameters.toJsonSchema().properties).not.toHaveProperty("shellState");
});

it("checks reviewed commands locally when an ACP terminal is available", async () => {
	await tool().execute("prime", { command: ":" });
	const report = await executor.inspectShellSession(cwd, []);
	if (!report) throw new Error("Expected an inspectable shell");
	const createTerminal = vi.fn(async () => {
		throw new Error("ACP bypassed review");
	});
	const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal };
	await tool({ getClientBridge: () => bridge }).execute("review", {
		command: "printf local > marker",
		shellState: { state: report.fingerprint, files: [] },
	});
	expect(await Bun.file(path.join(cwd, "marker")).text()).toBe("local");
	expect(createTerminal).not.toHaveBeenCalled();
});

it("keeps snapshot and export baselines across an executor timeout and core rebuild", async () => {
	const snapshot = path.join(cwd, "snapshot.sh");
	await Bun.write(snapshot, "export REVIEW_BASE=original\n");
	vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
		shell: "/bin/bash",
		args: ["-c"],
		prefix: undefined,
		env: { PATH: Bun.env.PATH ?? "", HOME: cwd, SHELL: "/bin/bash" },
	});
	vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(snapshot);
	await executor.executeBash(":", { sessionKey: cwd, cwd });
	expect((await executor.inspectShellSession(cwd, []))?.snapshotChanged).toBe(false);
	const interrupted = await executor.executeBash("sleep 10", { sessionKey: cwd, cwd, timeout: 20 });
	expect(interrupted.timedOut).toBe(true);
	await Bun.write(snapshot, "export REVIEW_BASE=edited\n");
	await executor.executeBash(":", { sessionKey: cwd, cwd });
	const rebuilt = await executor.inspectShellSession(cwd, []);
	expect(rebuilt?.snapshotChanged).toBe(true);
	expect(rebuilt?.exportsChanged).toContain("REVIEW_BASE");
});

it("inspects existing sessions without generating a snapshot for a missing session", async () => {
	vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
		shell: "/bin/bash",
		args: ["-c"],
		prefix: undefined,
		env: { PATH: Bun.env.PATH ?? "", HOME: cwd, SHELL: "/bin/bash" },
	});
	const snapshot = vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(null);
	await executor.executeBash(":", { sessionKey: cwd, cwd });
	snapshot.mockClear();
	snapshot.mockRejectedValue(new Error("inspection executed setup"));
	expect(await executor.inspectShellSession(`${cwd}:missing`, [])).toBeUndefined();
	expect(await executor.inspectShellSession(cwd, [])).toMatchObject({ snapshotChanged: false });
	expect(snapshot).not.toHaveBeenCalled();
});

it("refuses a token without a persistent shell before generating or sourcing a snapshot", async () => {
	vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
		shell: "/bin/bash",
		args: ["-c"],
		prefix: undefined,
		env: { PATH: Bun.env.PATH ?? "", HOME: cwd, SHELL: "/bin/bash" },
	});
	const snapshot = vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockImplementation(async () => {
		await Bun.write(path.join(cwd, "snapshot-marker"), "sourced");
		return null;
	});
	await expect(
		executor.executeBash("printf forbidden > marker", {
			sessionKey: cwd,
			cwd,
			expect: { state: "0".repeat(64), files: [] },
		}),
	).rejects.toThrow("the shell changed after this command was reviewed (shell is missing); run it again");
	expect(await Bun.file(path.join(cwd, "snapshot-marker")).exists()).toBe(false);
	expect(snapshot).not.toHaveBeenCalled();
});

it("selects the unminimized persistent shell and refuses ambiguous shaping variants", async () => {
	settings = Settings.isolated({ "shellMinimizer.enabled": true });
	vi.spyOn(Settings, "init").mockResolvedValue(settings);
	await executor.executeBash(":", { sessionKey: cwd, cwd, minimize: false });
	expect(await executor.inspectShellSession(cwd, ["printf"])).toMatchObject({
		resolution: [{ name: "printf", kind: "builtin", usable: true }],
	});
	await executor.executeBash(":", { sessionKey: cwd, cwd });
	expect(await executor.inspectShellSession(cwd, [])).toBeUndefined();
});

it("keeps a session uninspectable after an unexpected backend failure until it is released", async () => {
	await executor.executeBash(":", { sessionKey: cwd, cwd });
	vi.spyOn(Shell.prototype, "run").mockRejectedValueOnce(new Error("backend failed"));
	await expect(executor.executeBash(":", { sessionKey: cwd, cwd })).rejects.toThrow("backend failed");
	await executor.executeBash(":", { sessionKey: cwd, cwd });
	expect(await executor.inspectShellSession(cwd, [])).toBeUndefined();
	executor.releaseShellSessions(cwd);
	await executor.executeBash(":", { sessionKey: cwd, cwd });
	expect(await executor.inspectShellSession(cwd, [])).toMatchObject({ snapshotChanged: false });
});

it("fails closed after abandoning an unresponsive shell at the cleanup deadline", async () => {
	await executor.executeBash(":", { sessionKey: cwd, cwd });
	const realSetTimeout = globalThis.setTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...args: unknown[]) =>
		realSetTimeout(handler, ms === 6_000 || ms === 30_000 ? 5 : ms, ...args)) as typeof setTimeout);
	const hanging = Promise.withResolvers<ShellRunResult>();
	vi.spyOn(Shell.prototype, "run").mockImplementationOnce(() => hanging.promise);
	const interrupted = await executor.executeBash(":", { sessionKey: cwd, cwd, timeout: 1 });
	expect(interrupted.timedOut).toBe(true);
	await Bun.sleep(20);
	await executor.executeBash(":", { sessionKey: cwd, cwd });
	expect(await executor.inspectShellSession(cwd, [])).toBeUndefined();
});
