import { logger } from "@oh-my-pi/pi-utils";
import { sharpshooterBackend } from "../sharpshooter/backend";
import type {
	MemoryBackend,
	MemoryBackendOperationContext,
	MemoryBackendSearchOptions,
	MemoryBackendStartOptions,
} from "./types";

/**
 * Run sharpshooter alongside a store backend.
 *
 * Sharpshooter is not a store. It distills friction-gated project decisions into
 * three markdown files and injects them; it never holds arbitrary memories, and
 * its `status` reports `writable: false`. So it competes with mnemopi, hindsight
 * and local for the single backend slot without needing what that slot provides,
 * and pairing gives a session both searchable recall and always-on project rules.
 *
 * The wrapper keeps the primary's `id`. Tool gating across the agent reads
 * `memory.backend` directly rather than the resolved backend, and sharpshooter
 * appears in none of those checks, so the primary's tools stay exactly as they
 * were.
 *
 * Nothing that rewrites or removes the decision files fans out. Sharpshooter
 * replaces all three whole on every consolidation and keeps no history, so a
 * bad rewrite is unrecoverable: #10200 fixed a consolidation that returned
 * all-empty content, truncated every file, consumed the queued deltas and
 * recorded success, and that guard still admits a replacement that empties one
 * file out of three. An action aimed at the selected backend must not be able
 * to trigger either. `clear` and `enqueue` therefore reach the primary alone.
 */
export function withSharpshooter(primary: MemoryBackend): MemoryBackend {
	/**
	 * Run something on sharpshooter, swallowing its failure.
	 *
	 * Only the paired backend is shielded. The selected backend's errors propagate
	 * exactly as they did before pairing: a caller that would have seen a failed
	 * retain must still see it, or pairing turns real failures into silent ones.
	 */
	const paired = async <T>(label: string, run: () => Promise<T> | T): Promise<T | undefined> => {
		try {
			return await run();
		} catch (error) {
			logger.warn(`Sharpshooter ${label} failed while paired`, { backend: primary.id, error: String(error) });
			return undefined;
		}
	};
	/**
	 * Run both legs, then report the primary's outcome.
	 *
	 * Sharpshooter runs whether or not the primary threw, so one backend failing
	 * cannot quietly skip the other; the primary's error still reaches the caller.
	 */
	const legs = async <T>(
		label: string,
		runPrimary: () => Promise<T>,
		runPaired: () => Promise<T | undefined>,
	): Promise<[T | undefined, T | undefined]> => {
		const settled = await Promise.allSettled([runPrimary()]);
		const extra = await paired(label, runPaired);
		const [result] = settled;
		if (result?.status === "rejected") throw result.reason;
		return [result?.value, extra];
	};
	const joined = async (
		label: string,
		run: (backend: MemoryBackend) => Promise<string | undefined>,
	): Promise<string | undefined> => {
		const parts = (
			await legs(
				label,
				() => run(primary),
				() => run(sharpshooterBackend),
			)
		)
			.map(part => part?.trim())
			.filter((part): part is string => Boolean(part));
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	};

	return {
		id: primary.id,

		/**
		 * Registers sharpshooter before yielding, then awaits the primary.
		 *
		 * `sharpshooterBackend.start` is synchronous, and calling it before the
		 * first await means its subscription and scheduler exist by the time this
		 * returns a promise at all. That matters because the SDK discards the
		 * returned promise (`sdk.ts`, the non-autolearn branch) while disposal
		 * releases sharpshooter unconditionally: a registration that happened after
		 * an awaited hop could land past the release and strand the per-bank
		 * scheduler refcount for the life of the process.
		 */
		start(options: MemoryBackendStartOptions): Promise<void> {
			try {
				sharpshooterBackend.start(options);
			} catch (error) {
				logger.warn("Sharpshooter start failed while paired", { backend: primary.id, error: String(error) });
			}
			return Promise.resolve(primary.start(options));
		},

		buildDeveloperInstructions(agentDir, settings, session) {
			return joined("instructions", backend => backend.buildDeveloperInstructions(agentDir, settings, session));
		},

		/**
		 * Clears the selected backend only; see the note on the wrapper. Select
		 * sharpshooter as the backend to clear its decision files deliberately.
		 */
		async clear(agentDir, cwd, session): Promise<void> {
			await primary.clear(agentDir, cwd, session);
		},

		/**
		 * Consolidates the selected backend only.
		 *
		 * Sharpshooter's `enqueue` forces a consolidation, which asks a model to
		 * rewrite all three decision files and then consumes the queued deltas. A
		 * reply that empties one file passes the all-empty guard and is written, so
		 * `/memory sync` aimed at the store would be able to erode rules it was
		 * never pointed at. Sharpshooter's own scheduler still consolidates on its
		 * interval, so nothing is stranded.
		 */
		async enqueue(agentDir, cwd, session): Promise<void> {
			await primary.enqueue(agentDir, cwd, session);
		},

		async status(context: MemoryBackendOperationContext) {
			// Through `legs`, so a primary that throws still lets sharpshooter report.
			const [primaryStatus, extra] = await legs(
				"status",
				async () =>
					primary.status
						? await primary.status(context)
						: { backend: primary.id, active: primary.id !== "off", writable: false, searchable: false },
				async () => sharpshooterBackend.status?.(context),
			);
			const status = primaryStatus ?? {
				backend: primary.id,
				active: primary.id !== "off",
				writable: false,
				searchable: false,
			};
			const message = [status.message, extra?.message ? `sharpshooter — ${extra.message}` : undefined]
				.filter(Boolean)
				.join("; ");
			return {
				...status,
				// This wrapper answers search from sharpshooter even when the selected
				// backend cannot, so a caller must not be told search is unavailable.
				searchable: status.searchable || Boolean(extra?.searchable),
				...(message ? { message } : {}),
			};
		},

		async search(context: MemoryBackendOperationContext, query: string, options?: MemoryBackendSearchOptions) {
			const [primaryResult, extra] = await legs(
				"search",
				async () =>
					primary.search
						? await primary.search(context, query, options)
						: { backend: primary.id, query, count: 0, items: [] },
				async () => sharpshooterBackend.search?.(context, query, options),
			);
			const result = primaryResult ?? { backend: primary.id, query, count: 0, items: [] };
			if (!extra || extra.items.length === 0) return result;
			// Both backends apply the caller's limit to their own results, so the
			// merged set has to be trimmed again or two halves become twice the limit.
			const merged = [...result.items, ...extra.items];
			const items = options?.limit !== undefined ? merged.slice(0, Math.max(0, options.limit)) : merged;
			return { ...result, items, count: items.length };
		},

		stats(agentDir, cwd, session) {
			return joined("stats", backend => Promise.resolve(backend.stats?.(agentDir, cwd, session)));
		},

		diagnose(agentDir, cwd, session) {
			return joined("diagnose", backend => Promise.resolve(backend.diagnose?.(agentDir, cwd, session)));
		},

		queuePreview(context: MemoryBackendOperationContext) {
			return joined("queue", backend => Promise.resolve(backend.queuePreview?.(context)));
		},

		...(primary.save ? { save: primary.save.bind(primary) } : {}),
		...(primary.beforeAgentStartPrompt
			? { beforeAgentStartPrompt: primary.beforeAgentStartPrompt.bind(primary) }
			: {}),
		...(primary.preCompactionContext ? { preCompactionContext: primary.preCompactionContext.bind(primary) } : {}),
	};
}
