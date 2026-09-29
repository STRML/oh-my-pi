import { afterEach, describe, expect, it } from "bun:test";
import { type EmbedServer, startEmbedServer } from "@oh-my-pi/pi-mnemopi/embed-server";
import { embed, resetEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import type { LocalEmbeddingModel, LocalModelInitializer } from "@oh-my-pi/pi-mnemopi/core/embeddings";

const MODEL = "BAAI/bge-small-en-v1.5";

/** Deterministic 3-dim "model": [length, vowels, 1]. */
function fakeInitializer(counter: { loads: number }): LocalModelInitializer {
	return async () => {
		counter.loads += 1;
		const model: LocalEmbeddingModel = {
			async *embed(texts) {
				yield texts.map(text => [text.length, [...text].filter(c => "aeiou".includes(c)).length, 1]);
			},
		};
		return model;
	};
}

let server: EmbedServer | null = null;

afterEach(async () => {
	resetEmbeddingProviderForTests();
	await server?.stop();
	server = null;
});

async function post(body: unknown): Promise<Response> {
	return fetch(`${server?.url}/embeddings`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("mnemopi embed-serve", () => {
	it("returns OpenAI-shaped vectors in input order and loads the model once for many requests", async () => {
		const counter = { loads: 0 };
		server = await startEmbedServer({ port: 0, initializer: fakeInitializer(counter) });
		const first = (await (await post({ model: MODEL, input: ["hello", "sky"] })).json()) as {
			data: Array<{ index: number; embedding: number[] }>;
		};
		expect(first.data.map(row => [row.index, row.embedding])).toEqual([
			[0, [5, 2, 1]],
			[1, [3, 0, 1]],
		]);
		const single = (await (await post({ model: MODEL, input: "aeiou" })).json()) as {
			data: Array<{ embedding: number[] }>;
		};
		expect(single.data[0]?.embedding).toEqual([5, 5, 1]);
		expect(counter.loads).toBe(1);
	});

	it("rejects a request for a model it is not serving instead of returning wrong-dimension vectors", async () => {
		server = await startEmbedServer({ port: 0, initializer: fakeInitializer({ loads: 0 }) });
		const response = await post({ model: "BAAI/bge-base-en-v1.5", input: "x" });
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: { message: string } }).error.message).toContain(MODEL);
	});

	it("rejects malformed input with 400 and a model load failure with 500, then recovers on the next request", async () => {
		let attempts = 0;
		const flaky: LocalModelInitializer = async options => {
			attempts += 1;
			if (attempts === 1) throw new Error("onnx exploded");
			return fakeInitializer({ loads: 0 })(options);
		};
		server = await startEmbedServer({ port: 0, initializer: flaky });
		expect((await post({ input: 42 })).status).toBe(400);
		const failed = await post({ input: "x" });
		expect(failed.status).toBe(500);
		expect(((await failed.json()) as { error: { message: string } }).error.message).toContain("onnx exploded");
		expect((await post({ input: "x" })).status).toBe(200);
	});

	it("serves mnemopi's own API embedding client so processes can share one model", async () => {
		server = await startEmbedServer({ port: 0, model: MODEL, initializer: fakeInitializer({ loads: 0 }) });
		const saved = { url: Bun.env.MNEMOPI_EMBEDDING_API_URL, model: Bun.env.MNEMOPI_EMBEDDING_MODEL };
		Bun.env.MNEMOPI_EMBEDDING_API_URL = server.url;
		Bun.env.MNEMOPI_EMBEDDING_MODEL = MODEL;
		try {
			const vectors = await embed(["hello"]);
			expect(vectors?.map(v => Array.from(v))).toEqual([[5, 2, 1]]);
		} finally {
			for (const [key, value] of [
				["MNEMOPI_EMBEDDING_API_URL", saved.url],
				["MNEMOPI_EMBEDDING_MODEL", saved.model],
			] as const) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		}
	});
});
