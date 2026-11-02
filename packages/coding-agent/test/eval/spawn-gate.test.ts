import { afterAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { disposePyToolBridge } from "@oh-my-pi/pi-coding-agent/eval/py/tool-bridge";
import type { EvalSpawnBashInput } from "@oh-my-pi/pi-coding-agent/eval/spawn-gate";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { shellQuote } from "@oh-my-pi/pi-coding-agent/tools/bash-worktree-rewrite";
import { $which, TempDir } from "@oh-my-pi/pi-utils";

/**
 * Contract: every subprocess an eval kernel would start reaches the host's
 * `authorizeEvalSpawn` (the bash tool's gate) with its real command before it
 * runs, however the spawn was spelled; a refusal or a missing host bridge means
 * the process never starts.
 *
 * Each shape runs `touch <marker>` through a real kernel against a stub host
 * that records what it was asked and allows or denies. The marker file is the
 * proof: present after an allow, absent after a deny.
 */

// Kernel cold starts (Python runner, JS subprocess) exceed Bun's 5s default under load.
setDefaultTimeout(60_000);

const python = $which("python3") ?? $which("python");
const posix = process.platform !== "win32";
// Sandboxed hosts can lack pty devices; pty.spawn then fails before any spawn.
const ptyAvailable =
	!!python && posix && Bun.spawnSync([python, "-c", "import os; os.openpty()"], { stderr: "ignore" }).exitCode === 0;

const tempDir = TempDir.createSync("@omp-eval-spawn-gate-");
const sessionFile = path.join(tempDir.path(), "session.jsonl");
const judged: EvalSpawnBashInput[] = [];
let verdict: "allow" | "deny" = "allow";

const session = {
	cwd: tempDir.path(),
	hasUI: false,
	getSessionFile: () => sessionFile,
	getSessionSpawns: () => null,
	settings: Settings.isolated(),
	authorizeEvalSpawn: async (input: EvalSpawnBashInput) => {
		judged.push(input);
		// Holds a verdict open long enough for a cell thread to edit the call's arguments.
		if (input.command.includes("slow-")) await Bun.sleep(1_000);
		if (verdict === "deny") throw new Error("stub host denies this spawn");
	},
} as unknown as ToolSession;

/**
 * A directory a cell can prepend to PATH: its `touch` and `ps` stand-ins
 * record that they ran by creating `<arg>.hijacked` / `ps.hijacked`.
 */
const hijackDir = path.join(tempDir.path(), "hijack");
fs.mkdirSync(hijackDir);
for (const [name, body] of [
	["touch", '#!/bin/sh\n: > "$1.hijacked"\n'],
	["ps", `#!/bin/sh\n: > ${JSON.stringify(path.join(hijackDir, "ps.hijacked"))}\n`],
] as const) {
	fs.writeFileSync(path.join(hijackDir, name), body);
	fs.chmodSync(path.join(hijackDir, name), 0o755);
}

/** A hijacked spawn names the file that runs and carries the PATH that picked it. */
function expectHijacked(command: string, expectedTail: string): void {
	expect(command.startsWith("PATH=")).toBe(true);
	expect(command).toContain(hijackDir);
	expect(command.endsWith(` ${expectedTail}`)).toBe(true);
}

/** A directory with an executable `x` that creates `<dir>/x.ran`, for relative-path spawns. */
const otherDir = path.join(tempDir.path(), "other");
fs.mkdirSync(otherDir);
fs.writeFileSync(path.join(otherDir, "x"), `#!/bin/sh\n: > ${JSON.stringify(path.join(otherDir, "x.ran"))}\n`);
fs.chmodSync(path.join(otherDir, "x"), 0o755);

let markerSeq = 0;
function marker(): string {
	markerSeq += 1;
	return path.join(tempDir.path(), `marker-${markerSeq}`);
}

beforeEach(() => {
	judged.length = 0;
	verdict = "allow";
});

afterAll(async () => {
	await disposeAllKernelSessions();
	await disposeAllVmContexts();
	await disposePyToolBridge();
	tempDir.removeSync();
});

interface SpawnShape {
	name: string;
	/** Cell source that spawns `touch <file>`; `file` is already a valid string literal. */
	code: (file: string) => string;
	/** The command the host must be asked about; `touch <file>` unless the API quotes it. */
	expected?: (file: string) => string;
	/** The refusal lands in a forked child, which exits; its message is not cell output. */
	refusedInChild?: boolean;
	skip?: boolean;
}

const expectedCommand = (shape: SpawnShape, file: string) => shape.expected?.(file) ?? `touch ${file}`;

/** `null` runs on a kernel started with no tool session, so it has no host bridge. */
async function runPython(code: string, toolSession: ToolSession | null = session) {
	return await executePython(code, {
		cwd: tempDir.path(),
		sessionId: toolSession ? "spawn-gate-py" : "spawn-gate-py-unbridged",
		...(toolSession ? { toolSession } : {}),
	});
}

async function runJs(code: string) {
	return await executeJs(code, { cwd: tempDir.path(), sessionId: "spawn-gate-js", session, sessionFile });
}

const pythonShapes: SpawnShape[] = [
	{
		name: "getattr(os, 'sys' + 'tem')",
		code: f => `import os\ngetattr(os, "sys" + "tem")("touch " + ${f})`,
	},
	{
		name: "__builtins__ __import__ by string arithmetic, then popen",
		code: f =>
			[
				"b = __builtins__ if isinstance(__builtins__, dict) else __builtins__.__dict__",
				'm = b["__imp" + "ort__"]("o" + "s")',
				`getattr(m, "po" + "pen")("touch " + ${f}).read()`,
			].join("\n"),
	},
	{ name: "subprocess.run argv", code: f => `import subprocess\nsubprocess.run(["touch", ${f}])` },
	{
		name: "os.fork then os.execv",
		code: f =>
			[
				"import os",
				"pid = os.fork()",
				"if pid == 0:",
				"    try:",
				`        os.execv("/usr/bin/touch", ["touch", ${f}])`,
				"    finally:",
				"        os._exit(127)",
				"os.waitpid(pid, 0)",
			].join("\n"),
		refusedInChild: true,
	},
	{
		name: "os.posix_spawn",
		code: f => `import os\nos.waitpid(os.posix_spawn("/usr/bin/touch", ["touch", ${f}], os.environ), 0)`,
	},
	{
		name: "os.spawnv",
		code: f => `import os\nos.spawnv(os.P_WAIT, "/usr/bin/touch", ["touch", ${f}])`,
		refusedInChild: true,
	},
	{
		name: "pty.spawn",
		code: f => `import pty\npty.spawn(["touch", ${f}])`,
		refusedInChild: true,
		skip: !ptyAvailable,
	},
	{
		name: "a reloaded os module",
		code: f => `import importlib, os\nimportlib.reload(os).system("touch " + ${f})`,
	},
];

describe.skipIf(!python || !posix)("python kernel spawn gate", () => {
	for (const shape of pythonShapes) {
		it.skipIf(!!shape.skip)(`${shape.name}: reaches the host with its real command, then runs`, async () => {
			const file = marker();
			const result = await runPython(shape.code(JSON.stringify(file)));
			expect(result.output).not.toContain("spawn refused");
			expect(judged.map(input => input.command)).toContain(expectedCommand(shape, file));
			expect(await Bun.file(file).exists()).toBe(true);
		});

		it.skipIf(!!shape.skip)(`${shape.name}: a host deny stops it`, async () => {
			verdict = "deny";
			const file = marker();
			const result = await runPython(shape.code(JSON.stringify(file)));
			expect(judged.map(input => input.command)).toContain(expectedCommand(shape, file));
			expect(await Bun.file(file).exists()).toBe(false);
			if (!shape.refusedInChild) expect(result.output).toContain("eval subprocess spawn refused");
		});
	}

	it("judges a subprocess in the cwd it will run in", async () => {
		const file = marker();
		await runPython(`import subprocess\nsubprocess.run(["touch", ${JSON.stringify(file)}], cwd="/")`);
		expect(judged).toEqual([{ command: `touch ${file}`, cwd: "/" }]);
	});

	it("judges a PATH-hijacked program by the file that would run, not the name it was called by", async () => {
		const file = marker();
		await runPython(
			[
				"import os, subprocess",
				'start_path = os.environ["PATH"]',
				`os.environ["PATH"] = ${JSON.stringify(hijackDir)} + ":" + start_path`,
				`try: subprocess.run(["touch", ${JSON.stringify(file)}])`,
				'finally: os.environ["PATH"] = start_path',
			].join("\n"),
		);
		expect(judged).toHaveLength(1);
		expectHijacked(judged[0]!.command, `${path.join(hijackDir, "touch")} ${file}`);
	});

	it("does not let the runner's own ps listing run a hijacked ps unjudged", async () => {
		verdict = "deny";
		await runPython(
			[
				"import os, subprocess",
				'start_path = os.environ["PATH"]',
				`os.environ["PATH"] = ${JSON.stringify(hijackDir)} + ":" + start_path`,
				'try: subprocess.run(["ps", "-A", "-o", "pid=,ppid="])',
				"except PermissionError: pass",
				'finally: os.environ["PATH"] = start_path',
			].join("\n"),
		);
		expect(judged).toHaveLength(1);
		expectHijacked(judged[0]!.command, `${path.join(hijackDir, "ps")} -A -o pid=,ppid=`);
		expect(await Bun.file(path.join(hijackDir, "ps.hijacked")).exists()).toBe(false);
	});

	it("leaves a caught refusal's traceback unable to switch the gate off", async () => {
		verdict = "deny";
		const file = marker();
		const result = await runPython(
			[
				"import os",
				'try: os.system("true")',
				"except Exception as e:",
				"    tb = e.__traceback__.tb_next  # past the cell's own frame, into the gate's",
				"    while tb:",
				"        frame = tb.tb_frame",
				"        for value in list(frame.f_locals.values()):",
				"            if isinstance(value, dict): value.clear()",
				"        frame.f_globals.clear()",
				"        frame.f_builtins.clear()",
				"        tb = tb.tb_next",
				`os.system("touch " + ${JSON.stringify(file)})`,
			].join("\n"),
		);
		expect(judged.map(input => input.command)).toEqual(["true", `touch ${file}`]);
		expect(result.output).toContain("eval subprocess spawn refused");
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("judges a spawn from a thread the cell started under the running cell", async () => {
		const file = marker();
		await runPython(
			[
				"import subprocess",
				"from concurrent.futures import ThreadPoolExecutor",
				`ThreadPoolExecutor(1).submit(subprocess.run, ["touch", ${JSON.stringify(file)}]).result()`,
			].join("\n"),
		);
		expect(judged.map(input => input.command)).toEqual([`touch ${file}`]);
		expect(await Bun.file(file).exists()).toBe(true);
	});

	it("judges a relative executable in the subprocess cwd it runs from, and a deny stops it", async () => {
		const ran = path.join(otherDir, "x.ran");
		const code = `import subprocess\nsubprocess.run(["./x"], cwd=${JSON.stringify(otherDir)})`;
		verdict = "deny";
		const denied = await runPython(code);
		expect(denied.output).toContain("eval subprocess spawn refused");
		expect(judged).toEqual([{ command: `${otherDir}/./x`, cwd: otherDir }]);
		expect(await Bun.file(ran).exists()).toBe(false);
		verdict = "allow";
		await runPython(code);
		expect(await Bun.file(ran).exists()).toBe(true);
	});

	it("puts changed execution-affecting variables in front of the judged command", async () => {
		verdict = "deny";
		await runPython(
			[
				"import os, subprocess",
				'try: subprocess.run(["true"], env={**os.environ, "LD_PRELOAD": "/tmp/evil.so"})',
				"except PermissionError: pass",
				'os.environ["GIT_SSH_COMMAND"] = "ssh -o ProxyCommand=evil"',
				'try: os.system("git fetch")',
				"except PermissionError: pass",
				'finally: del os.environ["GIT_SSH_COMMAND"]',
			].join("\n"),
		);
		expect(judged.map(input => input.command)).toEqual([
			"LD_PRELOAD=/tmp/evil.so true",
			"GIT_SSH_COMMAND='ssh -o ProxyCommand=evil' /bin/sh -c 'git fetch'",
		]);
	});

	it("keeps the raw C fork_exec out of reach of cell code", async () => {
		const result = await runPython(
			[
				"import sys, _posixsubprocess",
				"print(_posixsubprocess.fork_exec.__closure__, _posixsubprocess.fork_exec.__defaults__)",
				'del sys.modules["_posixsubprocess"]',
				"import _posixsubprocess",
			].join("\n"),
		);
		expect(result.output).toContain("None None");
		expect(result.output).toContain("re-importing it would bypass the gate");
	});

	it("refuses a str subclass or argv list subclass, which could read one way to the gate and another to C", async () => {
		const file = marker();
		const quoted = JSON.stringify(file);
		const result = await runPython(
			[
				"import os, subprocess",
				"class S(str):",
				'    def __str__(self): return "echo benign"',
				"class L(list):",
				'    def __iter__(self): return iter(["true"])',
				"for attempt in (",
				`    lambda: subprocess.run(["/bin/sh", "-c", S("touch " + ${quoted})]),`,
				`    lambda: os.posix_spawn("/usr/bin/touch", L(["touch", ${quoted}]), os.environ),`,
				`    lambda: os.posix_spawn("/usr/bin/touch", ["touch", S(${quoted})], os.environ),`,
				"):",
				"    try: attempt(); print('RAN')",
				"    except PermissionError as e: print(e)",
			].join("\n"),
		);
		expect(result.output).not.toContain("RAN");
		expect(result.output.match(/eval subprocess spawn refused/g)?.length).toBe(3);
		expect(judged).toEqual([]);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("refuses an argv list another thread edits while the host is judging", async () => {
		const file = marker();
		const result = await runPython(
			[
				"import os, threading, time",
				`a = ["touch", "slow-" + ${JSON.stringify(file)}]`,
				"def flip():",
				"    time.sleep(0.4)",
				`    a[1] = ${JSON.stringify(file)}`,
				"threading.Thread(target=flip).start()",
				"try: os.waitpid(os.posix_spawn('/usr/bin/touch', a, dict(os.environ)), 0)",
				"except PermissionError as e: print(e)",
			].join("\n"),
		);
		expect(result.output).toContain("the arguments changed while the spawn was being judged");
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("refuses native extensions a cell writes, however they are loaded, without asking the host", async () => {
		const library = path.join(tempDir.path(), "native_mod.so");
		fs.writeFileSync(library, "not really a shared object");
		const result = await runPython(
			[
				"import importlib.machinery, importlib.util, _imp",
				"def by_loader():",
				`    loader = importlib.machinery.ExtensionFileLoader("native_mod", ${JSON.stringify(library)})`,
				`    importlib.util.module_from_spec(importlib.util.spec_from_file_location("native_mod", ${JSON.stringify(library)}, loader=loader))`,
				"def by_imp():",
				`    _imp.create_dynamic(importlib.machinery.ModuleSpec("native_mod", None, origin=${JSON.stringify(library)}))`,
				"def fresh_posix():",
				"    _imp.create_builtin(importlib.machinery.ModuleSpec('posix', None))",
				"for attempt in (by_loader, by_imp, fresh_posix):",
				"    try: attempt(); print('RAN')",
				"    except BaseException as e: print(type(e).__name__, e)",
			].join("\n"),
		);
		expect(result.output).not.toContain("RAN");
		expect(result.output.match(/eval subprocess spawn refused \(native extension\)/g)?.length).toBe(2);
		expect(result.output).toContain("eval subprocess spawn refused (_imp.create_builtin)");
		expect(judged).toEqual([]);
	});

	it("refuses subinterpreters, which run without the audit hook", async () => {
		const file = marker();
		const result = await runPython(
			[
				`F = ${JSON.stringify(file)}`,
				"def public():",
				"    import concurrent.interpreters as I",
				"    I.create().exec(f\"import os; os.system('touch {F}')\")",
				"def private():",
				"    import _interpreters as I",
				"    I.exec(I.create(), f\"import os; os.system('touch {F}')\")",
				"for attempt in (public, private):",
				"    try: attempt(); print('RAN')",
				"    except BaseException as e: print(type(e).__name__, e)",
			].join("\n"),
		);
		expect(result.output).not.toContain("RAN");
		expect(result.output.match(/subinterpreters run without the spawn gate/g)?.length).toBe(2);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("judges a relative subprocess cwd as the absolute directory it runs in", async () => {
		verdict = "deny";
		await runPython(
			[
				"import os, subprocess",
				"start = os.getcwd()",
				'os.chdir("/usr")',
				'try: subprocess.run(["true"], cwd="bin")',
				"except PermissionError: pass",
				"finally: os.chdir(start)",
			].join("\n"),
		);
		expect(judged.map(input => input.cwd)).toEqual(["/usr/bin"]);
	});

	it("judges every changed variable, not a list of known ones, and refuses exported bash functions", async () => {
		verdict = "deny";
		const result = await runPython(
			[
				"import os, subprocess",
				"env = dict(os.environ, GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='core.fsmonitor', GIT_CONFIG_VALUE_0='touch x #')",
				'try: subprocess.run(["git", "status"], env=env)',
				"except PermissionError: pass",
				"try: subprocess.run(['true'], env=dict(os.environ, **{'BASH_FUNC_ls%%': '() { :; }'}))",
				"except PermissionError as e: print(e)",
			].join("\n"),
		);
		expect(judged.map(input => input.command)).toEqual([
			"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0='touch x #' git status",
		]);
		expect(result.output).toContain("exported shell function BASH_FUNC_ls%%");
	});

	it("a kernel without a host bridge refuses spawns without running them", async () => {
		const file = marker();
		const result = await runPython(`import os\nos.system("touch " + ${JSON.stringify(file)})`, null);
		expect(result.output).toContain("no host bridge in this kernel");
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("refuses ctypes before it can load libc, without asking the host", async () => {
		const result = await runPython('import ctypes\nctypes.CDLL(None).system(b"true")');
		expect(result.output).toContain("eval subprocess spawn refused (_ctypes)");
		expect(judged).toEqual([]);
	});

	it("refuses tampering with the gate through gc introspection", async () => {
		const result = await runPython("import gc\ngc.get_objects()");
		expect(result.output).toContain("disabled by the spawn gate");
	});
});

const jsShapes: SpawnShape[] = [
	{
		name: "require of a computed child_process specifier",
		code: f => `require(["child", "_process"].join("")).execSync("touch " + ${f});`,
	},
	{
		name: "import() of a computed specifier with a computed method name",
		code: f => `const m = await import(["child", "_process"].join(""));\nm["ex" + "ecSync"]("touch " + ${f});`,
	},
	{
		name: '"child_pro" + "cess" spelling',
		code: f => `require("child_pro" + "cess").spawnSync("touch", [${f}]);`,
	},
	{
		name: "process.getBuiltinModule",
		code: f => `process.getBuiltinModule("child_process").execFileSync("touch", [${f}]);`,
	},
	{
		name: "async child_process.spawn",
		code: f => `await new Promise(r => require("node:child_process").spawn("touch", [${f}]).on("exit", r));`,
	},
	{ name: "Bun.spawnSync", code: f => `Bun.spawnSync(["touch", ${f}]);` },
	{ name: "Bun.spawn", code: f => `await Bun.spawn({ cmd: ["touch", ${f}] }).exited;` },
	{ name: "Bun.$", code: f => `await Bun.$\`touch \${${f}}\`;`, expected: f => `touch ${Bun.$.escape(f)}` },
];

describe.skipIf(!posix)("javascript kernel spawn gate", () => {
	for (const shape of jsShapes) {
		it(`${shape.name}: reaches the host with its real command, then runs`, async () => {
			const file = marker();
			const result = await runJs(shape.code(JSON.stringify(file)));
			expect(result.output).not.toContain("spawn refused");
			expect(judged.map(input => input.command)).toContain(expectedCommand(shape, file));
			expect(await Bun.file(file).exists()).toBe(true);
		});

		it(`${shape.name}: a host deny stops it`, async () => {
			verdict = "deny";
			const file = marker();
			const result = await runJs(shape.code(JSON.stringify(file)));
			expect(judged.map(input => input.command)).toContain(expectedCommand(shape, file));
			expect(result.output).toContain("eval subprocess spawn refused");
			expect(await Bun.file(file).exists()).toBe(false);
		});
	}

	it("judges a PATH-hijacked program by the file that would run, from process.env or options.env", async () => {
		const [first, second] = [marker(), marker()];
		await runJs(
			[
				`const hijacked = ${JSON.stringify(hijackDir)} + ":" + process.env.PATH;`,
				`Bun.spawnSync(["touch", ${JSON.stringify(first)}], { env: { ...process.env, PATH: hijacked } });`,
				"const startPath = process.env.PATH;",
				"process.env.PATH = hijacked;",
				`try { require("node:child_process").spawnSync("touch", [${JSON.stringify(second)}]); } finally { process.env.PATH = startPath; }`,
			].join("\n"),
		);
		const hijackedTouch = path.join(hijackDir, "touch");
		expect(judged).toHaveLength(2);
		expectHijacked(judged[0]!.command, `${hijackedTouch} ${first}`);
		expectHijacked(judged[1]!.command, `${hijackedTouch} ${second}`);
	});

	it("puts changed execution-affecting variables in front of the judged command", async () => {
		verdict = "deny";
		await runJs(
			[
				'try { Bun.spawnSync(["true"], { env: { ...process.env, LD_PRELOAD: "/tmp/evil.so" } }); } catch {}',
				'Bun.$.env({ ...process.env, GIT_SSH_COMMAND: "evil" });',
				"try { Bun.$`git fetch`; } catch {} finally { Bun.$.env(); }",
			].join("\n"),
		);
		expect(judged.map(input => input.command)).toEqual([
			"LD_PRELOAD=/tmp/evil.so true",
			"GIT_SSH_COMMAND=evil /bin/sh -c 'git fetch'",
		]);
	});

	it("judges Bun.$ again when .cwd() changes where it runs, before it runs", async () => {
		const file = marker();
		const result = await runJs(`await Bun.$\`touch \${${JSON.stringify(file)}}\`.cwd("/");`);
		expect(result.output).not.toContain("spawn refused");
		const command = `touch ${Bun.$.escape(file)}`;
		expect(judged).toEqual([
			{ command, cwd: expect.any(String) },
			{ command, cwd: "/" },
		]);
		expect(judged[0]!.cwd).not.toBe("/");
	});

	it("judges Bun.$ again when the prototype's .cwd()/.env() are called directly", async () => {
		verdict = "allow";
		const file = marker();
		await runJs(
			[
				`const p = Bun.$\`touch \${${JSON.stringify(file)}}\`;`,
				'Object.getPrototypeOf(p).cwd.call(p, "/");',
				'Object.getPrototypeOf(p).env.call(p, { ...process.env, GIT_DIR: "/tmp/elsewhere" });',
				"await p;",
			].join("\n"),
		);
		const command = `touch ${Bun.$.escape(file)}`;
		expect(judged.map(input => [input.command, input.cwd === "/"])).toEqual([
			[command, false],
			[command, true],
			[`GIT_DIR=/tmp/elsewhere /bin/sh -c ${shellQuote(command)}`, true],
		]);
	});

	it("judges a { raw } interpolation verbatim and refuses objects it cannot spell", async () => {
		verdict = "deny";
		const file = marker();
		const result = await runJs(
			[
				`try { await Bun.$\`echo hi \${{ raw: "; touch ${file}" }}\`; } catch (e) { console.log(e.message); }`,
				`try { await Bun.$\`echo hi > \${Bun.file(${JSON.stringify(file)})}\`; } catch (e) { console.log(e.message); }`,
			].join("\n"),
		);
		expect(judged.map(input => input.command)).toEqual([`echo hi ; touch ${file}`]);
		expect(result.output).toContain("only strings, numbers, arrays of them, { raw } and Buffers can be judged");
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("refuses Workers reached through any worker_threads import", async () => {
		const attempts = [
			'new (await import("node:worker_threads")).Worker("0", { eval: true })',
			'new (await import("worker_threads")).Worker("0", { eval: true })',
			'new (await (0, eval)("import(\'worker_threads\')")).Worker("0", { eval: true })',
		];
		const code = attempts
			.map(attempt => `try { ${attempt}; console.log("RAN"); } catch (e) { console.log(String(e.message)); }`)
			.join("\n");
		const result = await runJs(code);
		expect(result.output).not.toContain("RAN");
		expect(result.output.match(/a new realm would start without the spawn gate/g)?.length).toBe(attempts.length);
	});

	it("refuses every bun:ffi export, raw-pointer access included, and a cell resolver cannot reorder that", async () => {
		const attempts = [
			'process.getBuiltinModule("bun:ffi").ptr(new Uint8Array(8))',
			'process.getBuiltinModule("bun:ffi").toArrayBuffer(0, 0, 8)',
			'new (process.getBuiltinModule("bun:ffi").JSCallback)(() => 1, { returns: "int", args: [] })',
			"Bun.FFI.ptr(new Uint8Array(8))",
			[
				'Bun.plugin({ name: "cell", setup(b) { b.onResolve({ filter: /ffi/, namespace: "bun" }, a => ({ path: a.path, namespace: "bun" })); } });',
				'await import("bun:ffi")',
			].join(" "),
		];
		const code = attempts
			.map(attempt => `try { ${attempt}; console.log("RAN"); } catch (e) { console.log(String(e.message)); }`)
			.join("\n");
		const result = await runJs(code);
		expect(result.output).not.toContain("RAN");
		expect(result.output.match(/eval subprocess spawn refused/g)?.length).toBe(attempts.length - 1);
		expect(result.output).toContain("is not a constructor");
	});

	it("judges a relative spawn cwd as the absolute directory it runs in", async () => {
		verdict = "deny";
		await runJs(
			[
				"const start = process.cwd();",
				'process.chdir("/usr");',
				'try { Bun.spawnSync(["true"], { cwd: "bin" }); } catch {} finally { process.chdir(start); }',
			].join("\n"),
		);
		expect(judged.map(input => input.cwd)).toEqual(["/usr/bin"]);
	});

	it("judges every changed variable and refuses exported bash functions", async () => {
		verdict = "deny";
		const result = await runJs(
			[
				'const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor" };',
				'try { Bun.spawnSync(["git", "status"], { env }); } catch {}',
				'try { Bun.spawnSync(["true"], { env: { ...process.env, "BASH_FUNC_ls%%": "() { :; }" } }); } catch (e) { console.log(e.message); }',
			].join("\n"),
		);
		expect(judged.map(input => input.command)).toEqual([
			"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor git status",
		]);
		expect(result.output).toContain("exported shell function BASH_FUNC_ls%%");
	});

	it('refuses process.binding("spawn_sync") with the gate error, not Bun\'s', async () => {
		const result = await runJs('process.binding("spawn_sync");');
		expect(result.output).toContain('eval subprocess spawn refused (process.binding("spawn_sync"))');
	});

	it("refuses native code loading and new realms without asking the host", async () => {
		const attempts = [
			'await import("bun:" + "ffi")',
			"await (0, eval)(\"import('bun:ffi')\")",
			"await new Function(\"return import('bun:' + 'ffi')\")()",
			'require("bun:ffi").dlopen("libc.dylib", {})',
			'process.dlopen({ exports: {} }, "x.node")',
			'new Worker("data:text/javascript,0")',
			'new (require("node:worker_threads").Worker)("0", { eval: true })',
		];
		const code = attempts
			.map(attempt => `try { ${attempt}; console.log("RAN"); } catch (e) { console.log(String(e.message)); }`)
			.join("\n");
		const result = await runJs(code);
		expect(result.output).not.toContain("RAN");
		expect(result.output.match(/eval subprocess spawn refused/g)?.length).toBe(attempts.length);
		expect(judged).toEqual([]);
	});

	it("keeps the gated spawn functions in place when a cell tries to replace them", async () => {
		verdict = "deny";
		const file = marker();
		const result = await runJs(
			[
				"const own = (...a) => 0;",
				"try { Bun.spawnSync = own; } catch {}",
				'try { Object.defineProperty(Bun, "spawnSync", { value: own }); } catch {}',
				`Bun.spawnSync(["touch", ${JSON.stringify(file)}]);`,
			].join("\n"),
		);
		expect(result.output).toContain("eval subprocess spawn refused");
		expect(judged.map(input => input.command)).toEqual([`touch ${file}`]);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	// Last: disposing the host bridge leaves the live kernel pointing at a dead endpoint.
	it("refuses spawns once the host bridge is gone", async () => {
		await runJs("1");
		await disposePyToolBridge();
		const file = marker();
		const result = await runJs(`Bun.spawnSync(["touch", ${JSON.stringify(file)}]);`);
		expect(result.output).toContain("host bridge unreachable");
		expect(judged).toEqual([]);
		expect(await Bun.file(file).exists()).toBe(false);
	});
});
