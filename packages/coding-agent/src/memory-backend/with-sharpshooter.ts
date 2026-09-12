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
	const both = async (label: string, run: (backend: MemoryBackend) => Promise<unknown> | unknown): Promise<void> => {
		for (const backend of [primary, sharpshooterBackend]) {
			try {
				await run(backend);
			} catch (error) {
				// A paired backend must not be able to break the one the user selected.
				logger.warn(`Memory backend ${label} failed`, { backend: backend.id, error: String(error) });
			}
		}
	};
	const joined = async (run: (backend: MemoryBackend) => Promise<string | undefined>): Promise<string | undefined> => {
		const parts: string[] = [];
		for (const backend of [primary, sharpshooterBackend]) {
			try {
				const part = await run(backend);
				if (part?.trim()) parts.push(part.trim());
			} catch (error) {
				logger.warn("Memory backend section failed", { backend: backend.id, error: String(error) });
			}
		}
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

		async clear(agentDir, cwd, session): Promise<void> {
			await both("clear", backend => backend.clear(agentDir, cwd, session));
		},

		async enqueue(agentDir, cwd, session): Promise<void> {
			await both("enqueue", backend => backend.enqueue(agentDir, cwd, session));
		},

		async status(context: MemoryBackendOperationContext) {
			const status = primary.status
				? await primary.status(context)
				: { backend: primary.id, active: primary.id !== "off", writable: false, searchable: false };
			const paired = await sharpshooterBackend.status?.(context);
			const message = [status.message, paired?.message ? `sharpshooter — ${paired.message}` : undefined]
				.filter(Boolean)
				.join("; ");
			return { ...status, ...(message ? { message } : {}) };
		},

		async search(context: MemoryBackendOperationContext, query: string, options?: MemoryBackendSearchOptions) {
			const result = primary.search
				? await primary.search(context, query, options)
				: { backend: primary.id, query, count: 0, items: [] };
			const paired = await sharpshooterBackend.search?.(context, query, options);
			if (!paired || paired.items.length === 0) return result;
			const items = [...result.items, ...paired.items];
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
