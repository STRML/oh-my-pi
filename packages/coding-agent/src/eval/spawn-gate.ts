/**
 * Host side of the eval-kernel spawn gate.
 *
 * Both eval kernels intercept subprocess creation at the lowest layer they can
 * reach (Python: `posix`/`os` exec, spawn and system entry points,
 * `_posixsubprocess.fork_exec`; JavaScript: `Bun.spawn`/`Bun.spawnSync`, which
 * `node:child_process` calls into, plus `Bun.$`). Before a spawn happens the
 * kernel sends its real argv and cwd here and blocks for the verdict.
 *
 * The verdict comes from the bash tool's own gate: the spawn is presented as
 * the bash call it amounts to (`command` = the argv joined shell-safely, or the
 * shell string for `sh -c` forms) and runs through extension `tool_call`
 * handlers, preflight and approval policy exactly as a direct bash call does,
 * without executing anything here. The kernel spawns only after this resolves;
 * any error — blocked, denied, no bash tool, bridge failure — refuses it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ToolSession } from "../tools";
import { shellQuote } from "../tools/bash-worktree-rewrite";
import { withBridgeTimeoutPause } from "./bridge-timeout";
import type { JsStatusEvent } from "./js/shared/types";

/** Synthetic bridge name reserved for kernel spawn judgments across both runtimes. */
export const EVAL_SPAWN_BRIDGE_NAME = "__spawn__";

/** The bash tool input a judged spawn is presented as. */
export interface EvalSpawnBashInput {
	command: string;
	cwd: string;
}

/** What a kernel reports about one intercepted spawn. */
export interface EvalSpawnRequest {
	/** Kernel API that was called, e.g. `os.system` or `Bun.spawnSync`. */
	api: string;
	/** Real argv, when the API takes one. */
	argv?: string[];
	/** Shell command line, when the API takes one (`os.system`, `Bun.$`). */
	command?: string;
	/** Absolute directory the spawn runs in. */
	cwd: string;
	/** Absolute path of the file that runs, when the kernel resolved it. */
	program?: string;
	/** Variables set or changed relative to the kernel's startup environment. */
	env?: Record<string, string>;
	/** Variables present at kernel startup that the spawn's environment lacks. */
	unset?: string[];
}

export interface EvalSpawnBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

export interface EvalSpawnVerdict {
	allowed: true;
	command: string;
}

/** Shells whose `-c <script>` argv is judged as the script itself. */
const SYSTEM_SHELLS = new Set(
	["/bin", "/usr/bin"].flatMap(dir => ["sh", "bash", "zsh", "dash"].map(name => `${dir}/${name}`)),
);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function refused(message: string): ToolError {
	return new ToolError(`eval subprocess spawn refused: ${message}`);
}

/** A variable name the judged command can spell; exported bash functions are refused outright. */
function envName(api: string, name: string): string {
	if (!ENV_NAME.test(name)) throw refused(`${api}: environment variable ${JSON.stringify(name)} cannot be judged`);
	if (name.startsWith("BASH_FUNC_")) throw refused(`${api}: exported shell function ${name}`);
	return name;
}

function parseSpawnRequest(args: unknown): EvalSpawnRequest {
	if (!isRecord(args)) throw refused("malformed spawn request");
	const { api, argv, command, cwd, program } = args;
	if (typeof api !== "string" || api.length === 0) throw refused("spawn request names no API");
	if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw refused(`${api}: spawn request has no absolute cwd`);
	const request: EvalSpawnRequest = { api, cwd };
	if (typeof program === "string" && path.isAbsolute(program)) request.program = program;
	if (args.env !== undefined) {
		if (!isRecord(args.env)) throw refused(`${api}: malformed spawn env`);
		const env: Record<string, string> = {};
		for (const [name, value] of Object.entries(args.env)) {
			if (typeof value !== "string") throw refused(`${api}: malformed spawn env`);
			env[envName(api, name)] = value;
		}
		if (Object.keys(env).length > 0) request.env = env;
	}
	if (args.unset !== undefined) {
		if (!Array.isArray(args.unset) || !args.unset.every(name => typeof name === "string")) {
			throw refused(`${api}: malformed spawn env`);
		}
		const unset = args.unset.map(name => envName(api, name));
		if (unset.length > 0) request.unset = unset;
	}
	if (typeof command === "string" && command.length > 0) return { ...request, command };
	if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === "string")) {
		throw refused(`${api}: spawn request has no argv`);
	}
	return { ...request, argv };
}

/** Whether the file the kernel resolved is one of the system shells, after symlinks. */
function isSystemShell(program: string | undefined): boolean {
	if (!program || !path.isAbsolute(program)) return false;
	try {
		return SYSTEM_SHELLS.has(fs.realpathSync(program));
	} catch {
		return false;
	}
}

const byName = ([a]: [string, string], [b]: [string, string]): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The bash command a spawn amounts to, written so that running it in bash does
 * what the spawn does:
 *
 * - A `[shell, -c, script]` argv collapses to the script, which is how a bash
 *   tool call carries it, only when the kernel resolved the program to a
 *   system shell. Any other argv is joined with POSIX quoting.
 * - Every variable the spawn's environment sets, changes or removes relative
 *   to the kernel's startup environment leads the command: `VAR=value`
 *   assignments, behind `env -u NAME` when something was removed. A prefix
 *   assignment only reaches the first command of a script, so a shell command
 *   with an environment change is spelled as the `/bin/sh -c` it runs as.
 */
export function evalSpawnCommand(
	request: Pick<EvalSpawnRequest, "argv" | "command" | "env" | "unset" | "program">,
): string {
	const assignments = Object.entries(request.env ?? {})
		.sort(byName)
		.map(([name, value]) => `${name}=${shellQuote(value)} `)
		.join("");
	const removals = [...(request.unset ?? [])]
		.sort()
		.map(name => `-u ${name} `)
		.join("");
	const prefix = removals ? `env ${removals}${assignments}` : assignments;
	if (request.command !== undefined) {
		return prefix ? `${prefix}/bin/sh -c ${shellQuote(request.command)}` : request.command;
	}
	const argv = request.argv ?? [];
	if (!prefix && argv.length === 3 && argv[1] === "-c" && isSystemShell(request.program)) return argv[2];
	return prefix + argv.map(shellQuote).join(" ");
}

/** Judge one kernel spawn. Resolves only when it may run. */
export async function runEvalSpawnGate(args: unknown, options: EvalSpawnBridgeOptions): Promise<EvalSpawnVerdict> {
	const request = parseSpawnRequest(args);
	const command = evalSpawnCommand(request);
	const authorize = options.session.authorizeEvalSpawn;
	if (!authorize) throw refused(`${request.api}: this session has no spawn judge`);
	const toolCallId = `eval-spawn-${crypto.randomUUID()}`;
	try {
		// An approval prompt or a slow classifier is host-side waiting, not cell work.
		await withBridgeTimeoutPause(options.emitStatus, () =>
			authorize({ command, cwd: request.cwd }, toolCallId, options.signal, options.session.getToolContext?.()),
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		options.emitStatus?.({ op: "spawn", api: request.api, cmd: command, error: reason.slice(0, 500) });
		throw refused(`${request.api}: ${reason}`);
	}
	options.emitStatus?.({ op: "spawn", api: request.api, cmd: command });
	return { allowed: true, command };
}
