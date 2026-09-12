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
 * were. Only the methods sharpshooter actually implements are combined:
 * `beforeAgentStartPrompt`, `save` and `preCompactionContext` belong to the
 * primary alone, and `queuePreview` to sharpshooter alone.
 */
export function withSharpshooter(primary: MemoryBackend): MemoryBackend {
	/**
	 * Run something on sharpshooter, swallowing its failure.
	 *
	 * Only the paired backend is shielded. The selected backend's errors propagate
	 * exactly as they did before pairing: a caller that would have seen a failed
	 * retain or a failed consolidation must still see it, or pairing turns real
	 * failures into silent ones.
	 */
	const paired = async <T>(label: string, run: () => Promise<T> | T): Promise<T | undefined> => {
		try {
			return await run();
		} catch (error) {
			logger.warn(`Sharpshooter ${label} failed while paired`, { backend: primary.id, error: String(error) });
			return undefined;
		}
	};
	const both = async (label: string, run: (backend: MemoryBackend) => Promise<unknown> | unknown): Promise<void> => {
		await run(primary);
		await paired(label, () => run(sharpshooterBackend));
	};
	const joined = async (run: (backend: MemoryBackend) => Promise<string | undefined>): Promise<string | undefined> => {
		const parts = [await run(primary), await paired("section", () => run(sharpshooterBackend))]
			.map(part => part?.trim())
			.filter((part): part is string => Boolean(part));
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	};

	return {
		id: primary.id,

		start(options: MemoryBackendStartOptions): void {
			void both("start", backend => backend.start(options));
		},

		buildDeveloperInstructions(agentDir, settings, session) {
			return joined(backend => backend.buildDeveloperInstructions(agentDir, settings, session));
		},

		/**
		 * Clears the selected backend only.
		 *
		 * Sharpshooter's decision files are rewritten whole by a model on every
		 * consolidation and kept in no history, so there is nothing to restore them
		 * from. #10200 is the precedent: a consolidation that returned all-empty
		 * content truncated all three files, consumed the queued deltas, and recorded
		 * success. Wiping them as a side effect of clearing a different backend would
		 * be the same loss with a different trigger. Select sharpshooter as the
		 * backend to clear its files deliberately.
		 */
		async clear(agentDir, cwd, session): Promise<void> {
			await primary.clear(agentDir, cwd, session);
		},

		async enqueue(agentDir, cwd, session): Promise<void> {
			await both("enqueue", backend => backend.enqueue(agentDir, cwd, session));
		},

		async status(context: MemoryBackendOperationContext) {
			const status = primary.status
				? await primary.status(context)
				: { backend: primary.id, active: primary.id !== "off", writable: false, searchable: false };
			const extra = await paired("status", () => sharpshooterBackend.status?.(context));
			const message = [status.message, extra?.message ? `sharpshooter — ${extra.message}` : undefined]
				.filter(Boolean)
				.join("; ");
			return { ...status, ...(message ? { message } : {}) };
		},

		async search(context: MemoryBackendOperationContext, query: string, options?: MemoryBackendSearchOptions) {
			const result = primary.search
				? await primary.search(context, query, options)
				: { backend: primary.id, query, count: 0, items: [] };
			const extra = await paired("search", () => sharpshooterBackend.search?.(context, query, options));
			if (!extra || extra.items.length === 0) return result;
			const items = [...result.items, ...extra.items];
			return { ...result, items, count: items.length };
		},

		stats(agentDir, cwd, session) {
			return joined(backend => Promise.resolve(backend.stats?.(agentDir, cwd, session)));
		},

		diagnose(agentDir, cwd, session) {
			return joined(backend => Promise.resolve(backend.diagnose?.(agentDir, cwd, session)));
		},

		queuePreview(context: MemoryBackendOperationContext) {
			return joined(backend => Promise.resolve(backend.queuePreview?.(context)));
		},

		...(primary.save ? { save: primary.save.bind(primary) } : {}),
		...(primary.beforeAgentStartPrompt ? { beforeAgentStartPrompt: primary.beforeAgentStartPrompt.bind(primary) } : {}),
		...(primary.preCompactionContext ? { preCompactionContext: primary.preCompactionContext.bind(primary) } : {}),
	};
}
