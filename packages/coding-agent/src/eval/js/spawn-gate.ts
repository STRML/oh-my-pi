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
 * spawn-capable `process.binding` modules, `Bun.openInEditor`, new Workers,
 * whose fresh realm would start with an ungated `Bun`, and the test runner's
 * mock API (`Bun.jest`, `bun:test`), which could restore what the gate replaced.
 *
 * Built-in modules are patched through their CommonJS objects. A `node:*` ESM
 * namespace copies those exports when it is first imported, so the kernel's
 * own graph never imports `node:worker_threads` as ESM; the first import a cell
 * makes, by any specifier or resolver plugin, copies the locked `Worker`. The
 * `bun:ffi` ESM namespace already exists (the kernel's graph imports it), so its
 * exports are replaced in place, which every import of it then sees.
 *
 * Cell code can replace prototype methods and globals, so the gate calls none:
 * every helper it uses (string, array, typed-array, WeakMap and JSON methods)
 * is captured at load, copies are built with indexed loops and
 * `defineProperty`, and environments are null-prototype objects.
 *
 * The verdict must arrive synchronously (`spawnSync`, `execSync`), but the
 * host channel is asynchronous, so a helper thread created at install posts
 * the request over the loopback tool bridge and wakes this thread through a
 * SharedArrayBuffer. Each gated binding is redefined read-only and
 * non-configurable, so cell code cannot put the original back.
 */
import * as ffiNamespace from "bun:ffi";
import * as path from "node:path";
import type { Worker as ThreadWorker } from "node:worker_threads";

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

// Captured before any cell runs: cell code can replace these globals and
// prototype methods, but not the references held here.
const uncurry = Function.prototype.bind.bind(Function.prototype.call) as <A extends unknown[], R>(
	fn: (...args: A) => R,
) => (self: unknown, ...args: A) => R;
const startsWith = uncurry(String.prototype.startsWith) as (self: string, prefix: string) => boolean;
const includes = uncurry(String.prototype.includes) as (self: string, part: string) => boolean;
const split = uncurry(String.prototype.split) as unknown as (self: string, separator: string) => string[];
const sliceText = uncurry(String.prototype.slice) as (self: string, start: number, end?: number) => string;
const sliceBytes = uncurry(Uint8Array.prototype.slice) as (self: Uint8Array, start: number, end: number) => Uint8Array;
const decode = uncurry(TextDecoder.prototype.decode) as (self: TextDecoder, input: Uint8Array) => string;
const weakGet = uncurry(WeakMap.prototype.get) as (self: WeakMap<object, unknown>, key: object) => unknown;
const weakSet = uncurry(WeakMap.prototype.set) as (self: WeakMap<object, unknown>, key: object, value: unknown) => void;
const stringify = JSON.stringify;
const parseJson = JSON.parse;
const isArray = Array.isArray;
const isView = ArrayBuffer.isView;
const entriesOf = Object.entries;
const keysOf = Object.keys;
const ownNames = Object.getOwnPropertyNames;
const hasOwn = Object.hasOwn;
const createObject = Object.create;
const freeze = Object.freeze;
const defineProperty = Object.defineProperty;
const setPrototypeOf = Object.setPrototypeOf;
const preventExtensions = Object.preventExtensions;
const functionPrototype = Function.prototype;
const decoder = new TextDecoder();
const atomicsWait = Atomics.wait;
const atomicsStore = Atomics.store;
const atomicsLoad = Atomics.load;
const cwdOf = process.cwd.bind(process);
const resolvePath = path.resolve;
const which = Bun.which;

const REFUSED_PREFIX = "eval subprocess spawn refused";

class SpawnRefusedError extends Error {
	constructor(api: string, reason: string) {
		// A host refusal already names itself; don't stack a second prefix on it.
		super(startsWith(reason, REFUSED_PREFIX) ? reason : `${REFUSED_PREFIX} (${api}): ${reason}`);
		this.name = "SpawnRefusedError";
	}
}

type BuiltinModule = Record<string, unknown>;
const getBuiltinModule = (process as unknown as { getBuiltinModule(id: string): BuiltinModule }).getBuiltinModule.bind(
	process,
);
// Read from the CommonJS object before the gate locks its `Worker`.
const HelperWorker = getBuiltinModule("node:worker_threads").Worker as typeof ThreadWorker;

let installed = false;

/** Coerce once to a primitive string, so a value cannot read differently for the judge and for the spawn. */
function asText(value: unknown): string {
	return typeof value === "string" ? value : `${value}`;
}

/** Set an index without consulting setters a cell may have put on Array.prototype. */
function put<T>(target: T[], index: number, value: T): void {
	defineProperty(target, index, { value, writable: true, enumerable: true, configurable: true });
}

/** A copy of `source` built by index. */
function copyArray<T>(source: readonly T[]): T[] {
	const out: T[] = [];
	for (let i = 0; i < source.length; i++) put(out, i, source[i] as T);
	return out;
}

/** Copy an argv into a fresh frozen array of primitives: what is judged is what runs. */
function snapshotArgv(value: unknown): readonly string[] {
	const out: string[] = [];
	if (!isArray(value)) put(out, 0, asText(value));
	else for (let i = 0; i < value.length; i++) put(out, i, asText(value[i]));
	return freeze(out);
}

type Env = Record<string, string>;

/** Copy an environment into a null-prototype object of strings. */
function snapshotEnv(value: object): Env {
	const out = createObject(null) as Env;
	const entries = entriesOf(value);
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i] as [string, unknown];
		if (entry[1] !== undefined && entry[1] !== null) out[entry[0]] = asText(entry[1]);
	}
	return out;
}

/** A plain, frozen copy for the spawn APIs, which expect an ordinary object. */
function plainEnv(env: Env): Env {
	const out: Env = {};
	const names = keysOf(env);
	for (let i = 0; i < names.length; i++) {
		const name = names[i] as string;
		defineProperty(out, name, { value: env[name], writable: true, enumerable: true, configurable: true });
	}
	return freeze(out);
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
	// `enumerable` is left as it was: a non-configurable property cannot change it.
	defineProperty(target, key, { value, writable: false, configurable: false });
}

function refuser(api: string, reason: string): () => never {
	return () => {
		throw new SpawnRefusedError(api, reason);
	};
}

const NATIVE_CODE = "loading native code can call any libc function, so the eval kernel refuses it";

interface JudgeRequest {
	argv?: readonly string[];
	command?: string;
	/** Absolute. */
	cwd: string;
	/** The full environment the spawn runs with (null-prototype). */
	env: Env;
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
		return decode(decoder, sliceBytes(bytes, 0, atomicsLoad(flags, 1)));
	};

	/**
	 * Every variable that differs from the startup environment travels with the
	 * request. An exported bash function is refused when it was added or
	 * changed; one present at startup is left alone.
	 */
	const envChange = (api: string, env: Env): string => {
		let changed = "";
		const names = keysOf(env);
		for (let i = 0; i < names.length; i++) {
			const name = names[i] as string;
			const value = env[name] as string;
			if (hasOwn(startupEnv, name) && startupEnv[name] === value) continue;
			if (startsWith(name, "BASH_FUNC_")) {
				throw new SpawnRefusedError(api, `exported shell function ${name} would run inside any bash it starts`);
			}
			changed += `${changed ? "," : ""}${stringify(name)}:${stringify(value)}`;
		}
		let removed = "";
		const startupNames = keysOf(startupEnv);
		for (let i = 0; i < startupNames.length; i++) {
			const name = startupNames[i] as string;
			if (!hasOwn(env, name)) removed += `${removed ? "," : ""}${stringify(name)}`;
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
		if (startsWith(response, ALLOWED_PREFIX)) return;
		let reason = "denied";
		try {
			const parsed = parseJson(response) as { error?: unknown };
			if (
				parsed !== null &&
				typeof parsed === "object" &&
				hasOwn(parsed, "error") &&
				typeof parsed.error === "string"
			) {
				reason = parsed.error;
			}
		} catch {
			reason = sliceText(response, 0, 500) || "malformed host verdict";
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
 * The file a bare `program` resolves to, and the argv to judge (a frozen copy).
 * argv[0] stays as written when it names a path (resolved against the spawn's
 * cwd), when PATH has relative entries or the lookup fails (a changed PATH is
 * judged as a `PATH=` prefix instead), or when the startup PATH resolves it to
 * the same file. Otherwise it becomes the file that runs.
 */
function resolveArgv(
	argv: readonly string[],
	spawnPath: string,
	startupPath: string,
	cwd: string,
): { argv: readonly string[]; program?: string } {
	const name = argv[0];
	if (name === undefined) return { argv };
	if (includes(name, "/")) return { argv, program: resolvePath(cwd, name) };
	const entries = split(spawnPath, ":");
	for (let i = 0; i < entries.length; i++) {
		if (!startsWith(entries[i] as string, "/")) return { argv };
	}
	const executed = which(name, { PATH: spawnPath, cwd });
	if (executed === null) return { argv };
	if (executed === which(name, { PATH: startupPath, cwd })) return { argv, program: executed };
	const shown = copyArray(argv);
	put(shown, 0, executed);
	return { argv: freeze(shown), program: executed };
}

/** `Bun.spawn(cmd, options?)` and `Bun.spawn({ cmd, ...options })`, sync or not. */
function gateBunSpawn(key: "spawn" | "spawnSync", judge: Judge, startupPath: string): void {
	const original = Bun[key] as (...args: unknown[]) => unknown;
	const api = `Bun.${key}`;
	const gated = function (this: unknown, first: unknown, second?: unknown): unknown {
		// One read of each option, then only the copies are judged and spawned:
		// the spawn gets the same frozen argv the judge saw, an absolute cwd and
		// an env of plain strings. A null prototype keeps polluted
		// Object.prototype properties out of the options Bun reads.
		const fromArgv = isArray(first);
		const source = fromArgv ? second : first;
		const options = createObject(null) as Record<string, unknown>;
		if (source && typeof source === "object") {
			const entries = entriesOf(source);
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i] as [string, unknown];
				options[entry[0]] = entry[1];
			}
		}
		const argv = snapshotArgv(fromArgv ? first : options.cmd);
		const cwd = absoluteCwd(options.cwd);
		const env = snapshotEnv(options.env && typeof options.env === "object" ? options.env : process.env);
		options.cwd = cwd;
		options.env = plainEnv(env);
		const resolved = resolveArgv(argv, env.PATH ?? "", startupPath, cwd);
		judge(api, { argv: resolved.argv, program: resolved.program, cwd, env });
		if (fromArgv) return original.call(Bun, argv, options);
		options.cmd = argv;
		return original.call(Bun, options);
	};
	lock(Bun, key, gated);
}

interface ShellState {
	command: string;
	cwd: string;
	env: Env;
}

/**
 * `Bun.$` judges the command text it would run: literal parts as written, each
 * interpolated string escaped the way the shell escapes it, a `{ raw }` value
 * verbatim, a Buffer (a redirect source) as `<buffer>`. Any other object is
 * refused: a file or Response redirect target would be judged as text that
 * does not say what it writes. The promise is then bound to exactly the cwd and
 * env that were judged. Every builder that would hand back the ungated shell
 * returns the gated one instead.
 */
function gateBunShell(judge: Judge): void {
	const original = Bun.$;
	const escape = original.escape.bind(original);
	const states = new WeakMap<object, ShellState>();
	// `$.cwd()` / `$.env()` set defaults for later commands; the gate keeps its
	// own copy so each command is judged with the values it will run with.
	const defaults: { cwd?: string; env?: Env } = createObject(null);
	const proto = original.ShellPromise.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const setCwd = uncurry(proto.cwd as (dir: string) => unknown);
	const setEnv = uncurry(proto.env as (vars: Env) => unknown);

	const word = (value: unknown): { judged: string; passed: Bun.ShellExpression } => {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			const text = asText(value);
			return { judged: escape(text), passed: text };
		}
		if (isView(value)) return { judged: "<buffer>", passed: value as Bun.ShellExpression };
		if (value !== null && typeof value === "object" && !isArray(value) && hasOwn(value, "raw")) {
			const raw = asText((value as { raw: unknown }).raw);
			return { judged: raw, passed: freeze({ raw }) };
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
					put(list, j, item.passed);
					command += (j === 0 ? "" : " ") + item.judged;
				}
				put(words, words.length, freeze(list) as Bun.ShellExpression);
				continue;
			}
			const item = word(value);
			put(words, words.length, item.passed);
			command += item.judged;
		}
		const shell: ShellState = {
			command,
			cwd: defaults.cwd ?? cwdOf(),
			env: defaults.env ?? snapshotEnv(process.env),
		};
		judge("Bun.$", shell);
		const template = copyArray(parts);
		defineProperty(template, "raw", { value: freeze(copyArray(parts)) });
		const promise = original(freeze(template) as unknown as TemplateStringsArray, ...words) as Bun.$.ShellPromise;
		// Run with exactly what was judged, whatever the shell's own defaults are.
		setCwd(promise, shell.cwd);
		setEnv(promise, plainEnv(shell.env));
		weakSet(states, promise, shell);
		return promise;
	} as typeof Bun.$;

	// `.cwd()` / `.env()` change what runs after the judgment above. They are
	// replaced on the prototype (so `Object.getPrototypeOf(p).cwd.call(p)` meets
	// them too) and judge again with the new value before it takes effect.
	const stateOf = (promise: unknown): ShellState => {
		const shell =
			typeof promise === "object" && promise !== null
				? (weakGet(states, promise) as ShellState | undefined)
				: undefined;
		if (!shell) throw new SpawnRefusedError("Bun.$", "this shell command was not judged");
		return shell;
	};
	lock(proto, "cwd", function (this: unknown, dir: unknown) {
		const shell = stateOf(this);
		const cwd = absoluteCwd(dir);
		judge("Bun.$", { command: shell.command, cwd, env: shell.env });
		shell.cwd = cwd;
		setCwd(this, cwd);
		return this;
	});
	lock(proto, "env", function (this: unknown, vars: unknown) {
		const shell = stateOf(this);
		const env = snapshotEnv(vars && typeof vars === "object" ? vars : process.env);
		judge("Bun.$", { command: shell.command, cwd: shell.cwd, env });
		shell.env = env;
		setEnv(this, plainEnv(env));
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
		original.env(defaults.env ? plainEnv(defaults.env) : undefined);
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
	freeze(gated);
	lock(Bun, "$", gated);
}

function gateProcess(judge: Judge): void {
	const proc = process as unknown as Record<string, unknown>;
	const execve = proc.execve as ((file: string, args?: readonly string[], env?: unknown) => never) | undefined;
	if (typeof execve === "function") {
		lock(proc, "execve", (file: unknown, args?: unknown, env?: unknown) => {
			const program = resolvePath(cwdOf(), asText(file));
			const given = args === undefined ? snapshotArgv([program]) : snapshotArgv(args);
			// argv[0] is what the process sees; judge the file that actually runs.
			const argv: string[] = [];
			put(argv, 0, program);
			for (let i = 1; i < given.length; i++) put(argv, i, given[i] as string);
			const vars = snapshotEnv(env && typeof env === "object" ? env : process.env);
			judge("process.execve", { argv: freeze(argv), cwd: cwdOf(), env: vars, program });
			return execve.call(process, program, given, plainEnv(vars));
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

/** Replace every function or class export with a refuser and empty every nested table. */
function lockAllExports(target: BuiltinModule, refused: () => never): void {
	const names = ownNames(target);
	for (let i = 0; i < names.length; i++) {
		const key = names[i] as string;
		const value = target[key];
		if (typeof value === "function") lock(target, key, refused);
		else if (value !== null && typeof value === "object") lock(target, key, freeze({}));
	}
}

interface JestApi {
	spyOn(target: object, key: string): { mockImplementation(fn: () => never): unknown };
}

function refuseNativeCode(): void {
	const refused = refuser("bun:ffi", NATIVE_CODE);
	// The CommonJS object behind `process.getBuiltinModule("bun:ffi")`/`require`.
	lockAllExports(getBuiltinModule("bun:ffi"), refused);
	const bun = Bun as unknown as BuiltinModule;
	const ffi: BuiltinModule = {};
	const ffiNames = ownNames(bun.FFI as object);
	for (let i = 0; i < ffiNames.length; i++) ffi[ffiNames[i] as string] = refused;
	lock(bun, "FFI", freeze(ffi));

	// The ESM namespace was created by the kernel's own module graph before the
	// gate ran, so it still holds the real functions, and a cell resolver plugin
	// can redirect any specifier to it. Its bindings are replaced in place with
	// the test runner's spyOn (the one API that can rebind a module namespace).
	// Each mock is detached from the mock prototype and made non-extensible, so
	// `mockRestore()` cannot be reached; `Bun.jest` and `bun:test` are then
	// locked, so no `restoreAllMocks` can undo them.
	const jest = (bun.jest as (path: string) => JestApi)("omp-eval-spawn-gate");
	const namespace = ffiNamespace as unknown as BuiltinModule;
	const names = ownNames(namespace);
	for (let i = 0; i < names.length; i++) {
		const key = names[i] as string;
		const value = namespace[key];
		if (typeof value === "function") {
			const mock = jest.spyOn(namespace, key).mockImplementation(refused) as object;
			setPrototypeOf(mock, functionPrototype);
			preventExtensions(mock);
		} else if (value !== null && typeof value === "object") {
			// `read` holds raw memory readers.
			const table = value as BuiltinModule;
			const tableNames = ownNames(table);
			for (let j = 0; j < tableNames.length; j++) {
				if (typeof table[tableNames[j] as string] === "function") lock(table, tableNames[j] as string, refused);
			}
		}
	}
	const refusedMocks = refuser("Bun.jest", "the test runner's mock API could restore what the spawn gate replaced");
	lock(bun, "jest", refusedMocks);
	lockAllExports(getBuiltinModule("bun:test"), refusedMocks);
}
