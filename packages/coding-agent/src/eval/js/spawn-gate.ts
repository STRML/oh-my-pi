/**
 * Kernel side of the eval spawn gate for the JavaScript runtime.
 *
 * Installed once in the isolated eval process (or its Bun Worker fallback)
 * before any cell runs, never in the host realm. It replaces the process-
 * creating entry points with versions that send the real argv, cwd and
 * environment changes to the host and block until the host's bash gate
 * answers:
 *
 * - `Bun.spawn` / `Bun.spawnSync`. Bun's `node:child_process` (`spawn`, `exec`,
 *   `execFile`, `fork`, `*Sync`) calls these at call time, so it is covered no
 *   matter how the module was reached (`require`, `import()`,
 *   `process.getBuiltinModule`, a computed specifier).
 * - `Bun.$`, whose shell runs natively without `Bun.spawn`, including the
 *   `ShellPromise` `.cwd()` / `.env()` setters, which are judged again.
 * - `process.execve`, which replaces the process image.
 *
 * What cannot be judged as a command is refused: native code loading
 * (`process.dlopen`, so `require("*.node")`; `process._linkedBinding`; every
 * export of `bun:ffi` and `Bun.FFI`, raw-pointer reads and writes included),
 * spawn-capable `process.binding` modules, `Bun.openInEditor`, and new Workers,
 * whose fresh realm would start with an ungated `Bun`.
 *
 * Built-in modules are patched through their CommonJS objects. A `node:*` ESM
 * namespace copies those exports when it is first imported, so the kernel's
 * own graph must not import `node:worker_threads` as ESM before the gate
 * installs; the first cell import then sees the locked `Worker`. `bun:ffi` is
 * imported as ESM by the kernel's graph, so a resolver plugin refuses it for
 * every loader path instead.
 *
 * The verdict must arrive synchronously (`spawnSync`, `execSync`), but the
 * host channel is asynchronous, so a helper thread created at install posts
 * the request over the loopback tool bridge and wakes this thread through a
 * SharedArrayBuffer. Each gated binding is redefined read-only and
 * non-configurable, so cell code cannot put the original back.
 */
import * as path from "node:path";
import type { Worker as ThreadWorker } from "node:worker_threads";
// The CLI host imports this lazily after startup, and it imports `bun:ffi`,
// which the gate's resolver refuses once installed; load it before that.
import "@oh-my-pi/pi-utils/process-name";

export interface SpawnGateEndpoint {
	url: string;
	token: string;
	session: string;
}

/** What the gate needs to know about the spawn's owner at the moment it happens. */
export interface SpawnGateContext {
	endpoint: SpawnGateEndpoint | undefined;
	/** The eval run that owns this spawn; none means nothing on the host can judge it. */
	runId: string | undefined;
}

const VERDICT_TIMEOUT_MS = 600_000;
const RESPONSE_BYTES = 64 * 1024;
const ALLOWED_PREFIX = '{"ok":true,"value":{"allowed":true';
/** `process.binding` modules that create processes. */
const SPAWN_BINDINGS = new Set(["spawn_sync", "process_wrap", "child_process"]);

// node:http, not fetch: Bun's fetch honors HTTP(S)_PROXY, and a proxy must never
// see (or answer for) the loopback bridge.
const HELPER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const http = require("node:http");
parentPort.on("message", ({ state, data, url, token, body, timeoutMs }) => {
	const flags = new Int32Array(state);
	const bytes = new Uint8Array(data);
	const finish = text => {
		const encoded = new TextEncoder().encode(text);
		const length = Math.min(encoded.length, bytes.length);
		bytes.set(encoded.subarray(0, length));
		Atomics.store(flags, 1, length);
		Atomics.store(flags, 0, 1);
		Atomics.notify(flags, 0);
	};
	const fail = error => finish(JSON.stringify({ ok: false, error: "host bridge unreachable: " + (error && error.message ? error.message : String(error)) }));
	try {
		const target = new URL(url);
		const req = http.request(
			{ host: target.hostname, port: target.port, path: "/v1/tool", method: "POST", timeout: timeoutMs,
				headers: { authorization: "Bearer " + token, "content-type": "application/json" } },
			res => {
				const chunks = [];
				res.on("data", chunk => chunks.push(chunk));
				res.on("end", () => finish((res.statusCode === 200 ? "" : "HTTP " + res.statusCode + " ") + Buffer.concat(chunks).toString("utf8")));
				res.on("error", fail);
			},
		);
		req.on("timeout", () => req.destroy(new Error("verdict timed out")));
		req.on("error", fail);
		req.end(body);
	} catch (error) {
		fail(error);
	}
});
`;

const REFUSED_PREFIX = "eval subprocess spawn refused";

class SpawnRefusedError extends Error {
	constructor(api: string, reason: string) {
		// A host refusal already names itself; don't stack a second prefix on it.
		super(reason.startsWith(REFUSED_PREFIX) ? reason : `${REFUSED_PREFIX} (${api}): ${reason}`);
		this.name = "SpawnRefusedError";
	}
}

type BuiltinModule = Record<string, unknown>;
const getBuiltinModule = (process as unknown as { getBuiltinModule(id: string): BuiltinModule }).getBuiltinModule.bind(
	process,
);

// Captured before any cell runs: cell code can replace these globals, but not
// the references held here.
const stringify = JSON.stringify;
const parseJson = JSON.parse;
const isArray = Array.isArray;
const isView = ArrayBuffer.isView;
const entriesOf = Object.entries;
const decoder = new TextDecoder();
const atomicsWait = Atomics.wait;
const atomicsStore = Atomics.store;
const atomicsLoad = Atomics.load;
const defineProperty = Object.defineProperty;
const cwdOf = process.cwd.bind(process);
const resolvePath = path.resolve;
const which = Bun.which;
// Read from the CommonJS object before the gate locks its `Worker`.
const HelperWorker = getBuiltinModule("node:worker_threads").Worker as typeof ThreadWorker;

let installed = false;

/** Coerce once to a primitive string, so a value cannot read differently for the judge and for the spawn. */
function asText(value: unknown): string {
	return typeof value === "string" ? value : `${value}`;
}

/** Copy an argv into a fresh array of primitives; the copy is what both the judge and the spawn see. */
function snapshotArgv(value: unknown): string[] {
	if (!isArray(value)) return [asText(value)];
	const out: string[] = [];
	const length = value.length;
	for (let i = 0; i < length; i++) out[i] = asText(value[i]);
	return out;
}

/** Copy an environment into fresh string values; the copy is what both the judge and the spawn see. */
function snapshotEnv(value: object): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, entry] of entriesOf(value)) {
		if (entry !== undefined && entry !== null) out[name] = asText(entry);
	}
	return out;
}

/** A cwd made absolute against the kernel's cwd, as the spawn will run it. */
function absoluteCwd(value: unknown): string {
	return value === undefined || value === null ? cwdOf() : resolvePath(cwdOf(), asText(value));
}

function jsonArray(values: readonly string[]): string {
	let out = "[";
	for (let i = 0; i < values.length; i++) out += (i === 0 ? "" : ",") + stringify(values[i]);
	return `${out}]`;
}

function lock(target: object, key: string, value: unknown): void {
	defineProperty(target, key, { value, writable: false, configurable: false, enumerable: true });
}

function refuser(api: string, reason: string): () => never {
	return () => {
		throw new SpawnRefusedError(api, reason);
	};
}

const NATIVE_CODE = "loading native code can call any libc function, so the eval kernel refuses it";

interface JudgeRequest {
	argv?: string[];
	command?: string;
	/** Absolute. */
	cwd: string;
	/** The full environment the spawn runs with, as strings. */
	env: Record<string, string>;
	/** Absolute path of the file that runs, when resolved. */
	program?: string;
}

type Judge = (api: string, request: JudgeRequest) => void;

/**
 * Install the gate in this realm. `context` is read at each spawn; it is owned
 * by the WorkerCore, which cell code cannot reach.
 */
export function installJsSpawnGate(context: () => SpawnGateContext): void {
	if (installed) return;
	installed = true;

	const state = new SharedArrayBuffer(8);
	const data = new SharedArrayBuffer(RESPONSE_BYTES);
	const flags = new Int32Array(state);
	const bytes = new Uint8Array(data);
	let helper: ThreadWorker | undefined;
	const startupEnv = snapshotEnv(process.env);

	const ask = (endpoint: SpawnGateEndpoint, body: string): string => {
		helper ??= new HelperWorker(HELPER_SOURCE, { eval: true });
		helper.unref();
		atomicsStore(flags, 0, 0);
		atomicsStore(flags, 1, 0);
		helper.postMessage({
			state,
			data,
			url: endpoint.url,
			token: endpoint.token,
			body,
			timeoutMs: VERDICT_TIMEOUT_MS,
		});
		if (atomicsWait(flags, 0, 0, VERDICT_TIMEOUT_MS + 1_000) === "timed-out") {
			// A late answer must not land in the next request's buffer.
			void helper.terminate();
			helper = undefined;
			return stringify({ ok: false, error: "no verdict before the timeout" });
		}
		return decoder.decode(bytes.slice(0, atomicsLoad(flags, 1)));
	};

	/**
	 * Every variable that differs from the startup environment travels with the
	 * request; exported bash functions are refused outright.
	 */
	const envChange = (api: string, env: Record<string, string>): string => {
		let changed = "";
		for (const [name, value] of entriesOf(env)) {
			if (name.startsWith("BASH_FUNC_")) {
				throw new SpawnRefusedError(api, `exported shell function ${name} would run inside any bash it starts`);
			}
			if (startupEnv[name] === value) continue;
			changed += `${changed ? "," : ""}${stringify(name)}:${stringify(value)}`;
		}
		let removed = "";
		for (const name of Object.keys(startupEnv)) {
			if (!(name in env)) removed += `${removed ? "," : ""}${stringify(name)}`;
		}
		return `${changed ? `,"env":{${changed}}` : ""}${removed ? `,"unset":[${removed}]` : ""}`;
	};

	const judge: Judge = (api, request) => {
		const { endpoint, runId } = context();
		if (!endpoint) throw new SpawnRefusedError(api, "no host bridge in this kernel");
		if (!runId) throw new SpawnRefusedError(api, "no active eval run owns this spawn");
		const what =
			request.command !== undefined
				? `"command":${stringify(request.command)}`
				: `"argv":${jsonArray(request.argv ?? [])}`;
		const program = request.program !== undefined ? `,"program":${stringify(request.program)}` : "";
		// Built from primitives: JSON.stringify of an object or array would consult a cell-defined `toJSON`.
		const body = `{"session":${stringify(endpoint.session)},"run":${stringify(runId)},"name":"__spawn__","args":{"api":${stringify(api)},"cwd":${stringify(request.cwd)},${what}${program}${envChange(api, request.env)}}}`;
		const response = ask(endpoint, body);
		if (response.startsWith(ALLOWED_PREFIX)) return;
		let reason = "denied";
		try {
			const parsed = parseJson(response) as { error?: unknown };
			if (typeof parsed?.error === "string") reason = parsed.error;
		} catch {
			reason = response.slice(0, 500) || "malformed host verdict";
		}
		throw new SpawnRefusedError(api, reason);
	};

	gateBunSpawn("spawn", judge, startupEnv.PATH ?? "");
	gateBunSpawn("spawnSync", judge, startupEnv.PATH ?? "");
	gateBunShell(judge);
	gateProcess(judge);
	refuseNativeCode();
	lock(Bun, "openInEditor", refuser("Bun.openInEditor", "it runs $EDITOR, which the cell controls"));
	const refuseWorker = function Worker(): never {
		throw new SpawnRefusedError("Worker", "a new realm would start without the spawn gate");
	};
	lock(globalThis, "Worker", refuseWorker);
	lock(getBuiltinModule("node:worker_threads"), "Worker", refuseWorker);
}

/**
 * The file a bare `program` resolves to, and the argv to judge. argv[0] stays
 * as written when it names a path (resolved against the spawn's cwd), when PATH
 * has relative entries or the lookup fails (a changed PATH is judged as a
 * `PATH=` prefix instead), or when the startup PATH resolves it to the same
 * file. Otherwise it becomes the file that runs.
 */
function resolveArgv(
	argv: string[],
	spawnPath: string,
	startupPath: string,
	cwd: string,
): { argv: string[]; program?: string } {
	const name = argv[0];
	if (name === undefined) return { argv };
	if (name.includes("/")) return { argv, program: resolvePath(cwd, name) };
	if (spawnPath.split(":").some(entry => !entry.startsWith("/"))) return { argv };
	const executed = which(name, { PATH: spawnPath, cwd });
	if (executed === null) return { argv };
	if (executed === which(name, { PATH: startupPath, cwd })) return { argv, program: executed };
	const shown = argv.slice();
	shown[0] = executed;
	return { argv: shown, program: executed };
}

/** `Bun.spawn(cmd, options?)` and `Bun.spawn({ cmd, ...options })`, sync or not. */
function gateBunSpawn(key: "spawn" | "spawnSync", judge: Judge, startupPath: string): void {
	const original = Bun[key] as (...args: unknown[]) => unknown;
	const api = `Bun.${key}`;
	const gated = function (this: unknown, first: unknown, second?: unknown): unknown {
		// One read of each option, then only the copies are judged and spawned:
		// the spawn always gets an absolute cwd and an env of plain strings.
		const fromArgv = isArray(first);
		const source = fromArgv ? second : first;
		const options: Record<string, unknown> = source && typeof source === "object" ? { ...source } : {};
		const argv = snapshotArgv(fromArgv ? first : options.cmd);
		const cwd = absoluteCwd(options.cwd);
		const env = snapshotEnv(options.env && typeof options.env === "object" ? options.env : process.env);
		options.cwd = cwd;
		options.env = env;
		judge(api, { ...resolveArgv(argv, env.PATH ?? "", startupPath, cwd), cwd, env });
		if (fromArgv) return original.call(Bun, argv, options);
		options.cmd = argv;
		return original.call(Bun, options);
	};
	lock(Bun, key, gated);
}

interface ShellState {
	command: string;
	cwd: string;
	env: Record<string, string>;
}

/**
 * `Bun.$` judges the command text it would run: literal parts as written, each
 * interpolated string escaped the way the shell escapes it, a `{ raw }` value
 * verbatim, a Buffer (a redirect source) as `<buffer>`. Any other object is
 * refused: a file or Response redirect target would be judged as text that
 * does not say what it writes. Every builder that would hand back the ungated
 * shell returns the gated one instead.
 */
function gateBunShell(judge: Judge): void {
	const original = Bun.$;
	const escape = original.escape.bind(original);
	const states = new WeakMap<object, ShellState>();
	// `$.cwd()` / `$.env()` set defaults for later commands; the gate keeps its
	// own copy so each command is judged with the values it will run with.
	const defaults: { cwd?: string; env?: Record<string, string> } = {};

	const word = (value: unknown): { judged: string; passed: Bun.ShellExpression } => {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			const text = asText(value);
			return { judged: escape(text), passed: text };
		}
		if (isView(value)) return { judged: "<buffer>", passed: value as Bun.ShellExpression };
		if (value !== null && typeof value === "object" && !isArray(value) && "raw" in value) {
			const raw = asText((value as { raw: unknown }).raw);
			return { judged: raw, passed: { raw } };
		}
		throw new SpawnRefusedError("Bun.$", "only strings, numbers, arrays of them, { raw } and Buffers can be judged");
	};

	const gated = function (strings: TemplateStringsArray, ...values: unknown[]): unknown {
		const raw = strings.raw ?? strings;
		const parts = snapshotArgv(raw);
		const words: Bun.ShellExpression[] = [];
		let command = "";
		for (let i = 0; i < parts.length; i++) {
			command += parts[i];
			if (i >= values.length) continue;
			const value = values[i];
			if (isArray(value)) {
				const list: Bun.ShellExpression[] = [];
				for (let j = 0; j < value.length; j++) {
					const item = word(value[j]);
					list.push(item.passed);
					command += (j === 0 ? "" : " ") + item.judged;
				}
				words.push(list);
				continue;
			}
			const item = word(value);
			words.push(item.passed);
			command += item.judged;
		}
		const shell: ShellState = {
			command,
			cwd: defaults.cwd ?? cwdOf(),
			env: defaults.env ?? snapshotEnv(process.env),
		};
		judge("Bun.$", shell);
		const template = Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray;
		const promise = original(template, ...words) as Bun.$.ShellPromise;
		states.set(promise, shell);
		return promise;
	} as typeof Bun.$;

	// `.cwd()` / `.env()` change what runs after the judgment above. They are
	// replaced on the prototype (so `Object.getPrototypeOf(p).cwd.call(p)` meets
	// them too) and judge again with the new value before it takes effect.
	const proto = original.ShellPromise.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const setCwd = proto.cwd;
	const setEnv = proto.env;
	const stateOf = (promise: unknown): ShellState => {
		const shell = typeof promise === "object" && promise !== null ? states.get(promise) : undefined;
		if (!shell) throw new SpawnRefusedError("Bun.$", "this shell command was not judged");
		return shell;
	};
	lock(proto, "cwd", function (this: unknown, dir: unknown) {
		const shell = stateOf(this);
		const cwd = absoluteCwd(dir);
		judge("Bun.$", { ...shell, cwd });
		shell.cwd = cwd;
		setCwd.call(this, cwd);
		return this;
	});
	lock(proto, "env", function (this: unknown, vars: unknown) {
		const shell = stateOf(this);
		const env = snapshotEnv(vars && typeof vars === "object" ? vars : process.env);
		judge("Bun.$", { ...shell, env });
		shell.env = env;
		setEnv.call(this, env);
		return this;
	});

	const chain = (method: "nothrow" | "throws") =>
		function (...args: unknown[]) {
			(original[method] as (...a: unknown[]) => unknown)(...args);
			return gated;
		};
	const setDefaultCwd = function (dir?: unknown) {
		defaults.cwd = dir === undefined || dir === null ? undefined : absoluteCwd(dir);
		original.cwd(defaults.cwd);
		return gated;
	};
	const setDefaultEnv = function (vars?: unknown) {
		defaults.env = vars && typeof vars === "object" ? snapshotEnv(vars) : undefined;
		original.env(defaults.env);
		return gated;
	};
	defineProperty(gated, "escape", { value: escape });
	defineProperty(gated, "braces", { value: original.braces.bind(original) });
	defineProperty(gated, "cwd", { value: setDefaultCwd });
	defineProperty(gated, "env", { value: setDefaultEnv });
	defineProperty(gated, "nothrow", { value: chain("nothrow") });
	defineProperty(gated, "throws", { value: chain("throws") });
	defineProperty(gated, "ShellError", { value: original.ShellError });
	defineProperty(gated, "ShellPromise", { value: original.ShellPromise });
	defineProperty(gated, "Shell", { value: refuser("Bun.$.Shell", "a new shell instance would bypass the gate") });
	Object.freeze(gated);
	lock(Bun, "$", gated);
}

function gateProcess(judge: Judge): void {
	const proc = process as unknown as Record<string, unknown>;
	const execve = proc.execve as ((file: string, args?: string[], env?: unknown) => never) | undefined;
	if (typeof execve === "function") {
		lock(proc, "execve", (file: unknown, args?: unknown, env?: unknown) => {
			const file_ = resolvePath(cwdOf(), asText(file));
			const argv = args === undefined ? [file_] : snapshotArgv(args);
			const vars = snapshotEnv(env && typeof env === "object" ? env : process.env);
			judge("process.execve", {
				argv: argv.length === 0 ? [file_] : [file_, ...argv.slice(1)],
				cwd: cwdOf(),
				env: vars,
				program: file_,
			});
			return execve.call(process, file_, argv, vars);
		});
	}
	const binding = proc.binding as ((name: string) => unknown) | undefined;
	if (typeof binding === "function") {
		lock(proc, "binding", (name: unknown) => {
			const module = asText(name);
			if (SPAWN_BINDINGS.has(module)) {
				throw new SpawnRefusedError(
					`process.binding(${stringify(module)})`,
					"it creates processes outside the gate",
				);
			}
			return binding.call(process, module);
		});
	}
	lock(proc, "_linkedBinding", refuser("process._linkedBinding", NATIVE_CODE));
	lock(proc, "dlopen", refuser("process.dlopen", NATIVE_CODE));
}

/** Replace every function or class export with a refuser and freeze the nested `read` table. */
function lockAllExports(target: BuiltinModule, refused: () => never): void {
	for (const key of Object.getOwnPropertyNames(target)) {
		const value = target[key];
		if (typeof value === "function") lock(target, key, refused);
		else if (value !== null && typeof value === "object") lock(target, key, Object.freeze({}));
	}
}

function refuseNativeCode(): void {
	const refused = refuser("bun:ffi", NATIVE_CODE);
	// The ESM namespace of `bun:ffi` was fixed when the kernel's own module graph
	// imported it, so it cannot be patched in place. A resolver plugin refuses the
	// specifier for every loader path: static and dynamic imports, `require`,
	// indirect eval and `new Function`. `Bun.plugin` itself is a non-writable,
	// non-configurable property, so later registrations cannot be refused, but
	// the first resolver to throw wins over any a cell adds, and `clearAll` is
	// locked so ours cannot be removed.
	Bun.plugin({
		name: "omp-eval-spawn-gate",
		setup(build) {
			build.onResolve({ filter: /ffi/, namespace: "bun" }, () => {
				throw new SpawnRefusedError('import "bun:ffi"', NATIVE_CODE);
			});
		},
	});
	lock(Bun.plugin, "clearAll", refuser("Bun.plugin.clearAll", "it would remove the spawn gate's resolver"));
	// What `process.getBuiltinModule("bun:ffi")` and `Bun.FFI` hand out: every
	// export, so no raw-pointer read/write (`ptr`, `read`, `toArrayBuffer`) or
	// callback (`JSCallback`) survives either.
	lockAllExports(getBuiltinModule("bun:ffi"), refused);
	const bun = Bun as unknown as BuiltinModule;
	const ffi: BuiltinModule = {};
	for (const key of Object.getOwnPropertyNames(bun.FFI as object)) ffi[key] = refused;
	lock(bun, "FFI", Object.freeze(ffi));
}
