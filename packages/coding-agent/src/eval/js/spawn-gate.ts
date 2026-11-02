/**
 * Kernel side of the eval spawn gate for the JavaScript runtime.
 *
 * Installed once in the isolated eval process (or its Bun Worker fallback)
 * before any cell runs, never in the host realm. It replaces the process-
 * creating entry points with versions that send the real argv and cwd to the
 * host and block until the host's bash gate answers:
 *
 * - `Bun.spawn` / `Bun.spawnSync`. Bun's `node:child_process` (`spawn`, `exec`,
 *   `execFile`, `fork`, `*Sync`) calls these at call time, so it is covered no
 *   matter how the module was reached (`require`, `import()`,
 *   `process.getBuiltinModule`, a computed specifier).
 * - `Bun.$`, whose shell runs natively without `Bun.spawn`.
 * - `process.execve`, which replaces the process image.
 *
 * What cannot be judged as a command is refused: native code loading
 * (`process.dlopen`, so `require("*.node")`; `process._linkedBinding`; `bun:ffi`
 * and `Bun.FFI`), spawn-capable `process.binding` modules, `Bun.openInEditor`,
 * and new Workers, whose fresh realm would start with an ungated `Bun`.
 *
 * Built-in modules are patched through their CommonJS objects, which `require`
 * and `node:*` ESM namespaces share live. `bun:ffi` is the exception: its ESM
 * namespace was fixed when the kernel's own module graph imported it, so the
 * runtime's import hook refuses that specifier ({@link isRefusedImport}).
 *
 * The verdict must arrive synchronously (`spawnSync`, `execSync`), but the
 * host channel is asynchronous, so a helper thread created at install posts
 * the request over the loopback tool bridge and wakes this thread through a
 * SharedArrayBuffer. Each gated binding is redefined read-only and
 * non-configurable, so cell code cannot put the original back.
 */
import { Worker as ThreadWorker } from "node:worker_threads";

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

// Captured before any cell runs: cell code can replace these globals, but not
// the references held here.
const stringify = JSON.stringify;
const parseJson = JSON.parse;
const isArray = Array.isArray;
const decoder = new TextDecoder();
const atomicsWait = Atomics.wait;
const atomicsStore = Atomics.store;
const atomicsLoad = Atomics.load;
const defineProperty = Object.defineProperty;
const cwdOf = process.cwd.bind(process);
const which = Bun.which;
// Captured before the gate locks `worker_threads.Worker`, which named imports of it see live.
const HelperWorker = ThreadWorker;

let installed = false;

/** Modules whose ESM namespace predates the gate and so cannot be patched in place. */
const REFUSED_IMPORTS = new Set(["bun:ffi"]);

/** Whether the installed gate refuses a cell import of `specifier`. */
export function isRefusedImport(specifier: string): boolean {
	return installed && REFUSED_IMPORTS.has(specifier);
}

/** Throws the gate's refusal for an import {@link isRefusedImport} rejects. */
export function refuseImport(specifier: string): never {
	throw new SpawnRefusedError(`import ${stringify(specifier)}`, NATIVE_CODE);
}

type BuiltinModule = Record<string, unknown>;
const getBuiltinModule = (process as unknown as { getBuiltinModule(id: string): BuiltinModule }).getBuiltinModule.bind(
	process,
);

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
	const startupPath = process.env.PATH ?? "";

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

	const judge = (api: string, request: { argv?: string[]; command?: string; cwd?: unknown }): void => {
		const { endpoint, runId } = context();
		if (!endpoint) throw new SpawnRefusedError(api, "no host bridge in this kernel");
		if (!runId) throw new SpawnRefusedError(api, "no active eval run owns this spawn");
		const cwd = request.cwd === undefined || request.cwd === null ? cwdOf() : asText(request.cwd);
		const what =
			request.command !== undefined
				? `"command":${stringify(request.command)}`
				: `"argv":${jsonArray(request.argv ?? [])}`;
		// Built from primitives: JSON.stringify of an object or array would consult a cell-defined `toJSON`.
		const body = `{"session":${stringify(endpoint.session)},"run":${stringify(runId)},"name":"__spawn__","args":{"api":${stringify(api)},"cwd":${stringify(cwd)},${what}}}`;
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

	gateBunSpawn("spawn", judge, startupPath);
	gateBunSpawn("spawnSync", judge, startupPath);
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

type Judge = (api: string, request: { argv?: string[]; command?: string; cwd?: unknown }) => void;

/** `Bun.spawn(cmd, options?)` and `Bun.spawn({ cmd, ...options })`, sync or not. */
/**
 * The argv to judge. argv[0] stays as written only when the PATH the kernel
 * started with resolves it to the same file the spawn's own PATH does;
 * otherwise it becomes that file's path, so a PATH a cell set shows.
 */
function displayArgv(argv: string[], spawnPath: string, startupPath: string): string[] {
	const program = argv[0];
	if (program === undefined || program.includes("/")) return argv;
	const executed = which(program, { PATH: spawnPath });
	if (executed === null || executed === which(program, { PATH: startupPath })) return argv;
	const shown = argv.slice();
	shown[0] = executed;
	return shown;
}

function gateBunSpawn(key: "spawn" | "spawnSync", judge: Judge, startupPath: string): void {
	const original = Bun[key] as (...args: unknown[]) => unknown;
	const api = `Bun.${key}`;
	const gated = function (this: unknown, first: unknown, second?: unknown): unknown {
		// One read of each option, then only the copies are used.
		const fromArgv = isArray(first);
		const source = fromArgv ? second : first;
		const options: Record<string, unknown> = source && typeof source === "object" ? { ...source } : {};
		const argv = snapshotArgv(fromArgv ? first : options.cmd);
		if (options.cwd !== undefined && options.cwd !== null) options.cwd = asText(options.cwd);
		if (options.env && typeof options.env === "object") options.env = { ...options.env };
		const env = options.env as Record<string, unknown> | undefined;
		const spawnPath = env && env.PATH !== undefined ? asText(env.PATH) : (process.env.PATH ?? "");
		judge(api, { argv: displayArgv(argv, spawnPath, startupPath), cwd: options.cwd });
		if (fromArgv) return original.call(Bun, argv, options);
		options.cmd = argv;
		return original.call(Bun, options);
	};
	lock(Bun, key, gated);
}

/**
 * `Bun.$` judges the command text it would run: literal parts as written, each
 * interpolated string escaped the way the shell escapes it. Objects (Buffers,
 * Responses, files) are redirect sources and judged as `<object>`. Every
 * builder that would hand back the ungated shell returns the gated one instead.
 */
function gateBunShell(judge: Judge): void {
	const original = Bun.$;
	const escape = original.escape.bind(original);
	const gated = function (strings: TemplateStringsArray, ...values: unknown[]): unknown {
		const raw = strings.raw ?? strings;
		const parts = snapshotArgv(raw);
		const words: Bun.ShellExpression[] = [];
		let command = "";
		for (let i = 0; i < parts.length; i++) {
			command += parts[i];
			if (i >= values.length) continue;
			const value = values[i];
			if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
				const word = asText(value);
				words.push(word);
				command += escape(word);
			} else if (isArray(value)) {
				const list = snapshotArgv(value);
				words.push(list);
				for (let j = 0; j < list.length; j++) command += (j === 0 ? "" : " ") + escape(list[j]);
			} else {
				words.push(value as Bun.ShellExpression);
				command += "<object>";
			}
		}
		judge("Bun.$", { command });
		const template = Object.assign([...parts], { raw: [...parts] }) as unknown as TemplateStringsArray;
		return original(template, ...words);
	} as typeof Bun.$;
	const chain = (method: "cwd" | "env" | "nothrow" | "throws") =>
		function (...args: unknown[]) {
			(original[method] as (...a: unknown[]) => unknown)(...args);
			return gated;
		};
	defineProperty(gated, "escape", { value: escape });
	defineProperty(gated, "braces", { value: original.braces.bind(original) });
	defineProperty(gated, "cwd", { value: chain("cwd") });
	defineProperty(gated, "env", { value: chain("env") });
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
			const path = asText(file);
			const argv = args === undefined ? [path] : snapshotArgv(args);
			judge("process.execve", { argv: argv.length === 0 ? [path] : [path, ...argv.slice(1)] });
			return execve.call(process, path, argv, env);
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

function refuseNativeCode(): void {
	const refused = refuser("bun:ffi", NATIVE_CODE);
	const module = getBuiltinModule("bun:ffi");
	for (const key of ["dlopen", "linkSymbols", "CFunction", "cc"]) {
		if (key in module) lock(module, key, refused);
	}
	if ("native" in module) lock(module, "native", Object.freeze({ dlopen: refused, callback: refused }));
	const bun = Bun as unknown as BuiltinModule;
	lock(bun, "FFI", Object.freeze({ ...(bun.FFI as object), dlopen: refused, linkSymbols: refused, cc: refused }));
}
