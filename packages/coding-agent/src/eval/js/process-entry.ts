import { installJsSpawnGate } from "./spawn-gate";
import { type RejectionInterceptor, WorkerCore } from "./worker-core";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol";

/** Start the JavaScript evaluator inside a subprocess IPC transport. */
export function startJsEvalProcess(
	transport: {
		send(message: WorkerOutbound): void;
		onMessage(handler: (message: WorkerInbound) => void): () => void;
	},
	interceptUnhandledRejections: RejectionInterceptor,
): void {
	const core = new WorkerCore(
		{
			send: message => transport.send(message),
			onMessage: handler => transport.onMessage(handler),
			// The parent owns process lifetime and kills the subprocess after the
			// WorkerCore `closed` acknowledgement has crossed IPC.
			close: () => {},
		},
		{
			mode: "isolated",
			// The subprocess inherits the agent's cwd (or the package root under
			// the `bun test` fallback of `resolveWorkerSpawnCmd`); mirror the
			// session cwd so cell code using relative paths or spawning children
			// resolves against the session's project. Worker threads cannot pass
			// this — `process.chdir` is unavailable there.
			chdir: cwd => process.chdir(cwd),
			interceptUnhandledRejections,
		},
	);
	// This process runs only eval cells, so every spawn in it is gated. The
	// install waits one microtask so the subprocess host can start its
	// parent-watchdog Worker first (the gate refuses new Workers); no cell can
	// run before then, since cells arrive as IPC messages on later turns.
	queueMicrotask(() => installJsSpawnGate(() => core.spawnGateContext()));
}
