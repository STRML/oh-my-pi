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
	cwd: string;
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

const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash"]);

function refused(message: string): ToolError {
	return new ToolError(`eval subprocess spawn refused: ${message}`);
}

function parseSpawnRequest(args: unknown): EvalSpawnRequest {
	if (!isRecord(args)) throw refused("malformed spawn request");
	const { api, argv, command, cwd } = args;
	if (typeof api !== "string" || api.length === 0) throw refused("spawn request names no API");
	if (typeof cwd !== "string" || cwd.length === 0) throw refused(`${api}: spawn request has no cwd`);
	if (typeof command === "string" && command.length > 0) return { api, command, cwd };
	if (!Array.isArray(argv) || argv.length === 0 || !argv.every(arg => typeof arg === "string")) {
		throw refused(`${api}: spawn request has no argv`);
	}
	return { api, argv, cwd };
}

/**
 * The bash command a spawn amounts to. A `sh -c <script>` argv is the script
 * itself, which is how a bash tool call carries it; any other argv is joined
 * with POSIX quoting so the judged text runs the same program with the same
 * arguments.
 */
export function evalSpawnCommand(request: Pick<EvalSpawnRequest, "argv" | "command">): string {
	if (request.command !== undefined) return request.command;
	const argv = request.argv ?? [];
	const shell = argv[0]?.split("/").pop();
	if (argv.length === 3 && shell !== undefined && SHELL_NAMES.has(shell) && argv[1] === "-c") return argv[2];
	return argv.map(shellQuote).join(" ");
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
