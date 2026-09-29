import { defaultLocalModelInitializer, currentEmbeddingModel, fastembedModelName } from "./core/embeddings";
import type { LocalEmbeddingModel, LocalModelInitializer } from "./core/embeddings";

/** Loopback default: the server has no auth, so it never listens beyond this host unless asked. */
export const EMBED_SERVE_DEFAULT_HOST = "127.0.0.1";
export const EMBED_SERVE_DEFAULT_PORT = 11439;

export interface EmbedServerOptions {
	readonly host?: string;
	readonly port?: number;
	/** Embedding model name as mnemopi stores it, e.g. `BAAI/bge-small-en-v1.5`. Requests naming another model get a 400. */
	readonly model?: string;
	/** Loads the fastembed model. Overridable so tests can serve deterministic vectors. */
	readonly initializer?: LocalModelInitializer;
	/** Load the model at startup instead of on the first request. */
	readonly preload?: boolean;
}

export interface EmbedServer {
	readonly url: string;
	readonly model: string;
	stop(): Promise<void>;
}

interface EmbeddingsRequest {
	readonly model?: unknown;
	readonly input?: unknown;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function errorResponse(status: number, message: string): Response {
	return json({ error: { message, type: "invalid_request_error" } }, status);
}

function parseInputs(input: unknown): string[] | null {
	if (typeof input === "string") return [input];
	if (Array.isArray(input) && input.every(item => typeof item === "string")) return input;
	return null;
}

async function drain(model: LocalEmbeddingModel, texts: string[]): Promise<number[][]> {
	const rows: number[][] = [];
	for await (const batch of model.embed(texts)) {
		for (const row of batch) rows.push(Array.from(row));
	}
	return rows;
}

/**
 * Serve one fastembed model over an OpenAI-compatible `POST /v1/embeddings`, so many
 * mnemopi processes can point `MNEMOPI_EMBEDDING_API_URL` at it instead of each loading
 * their own copy of the ONNX runtime (about 1 GB resident apiece). Vectors come from the
 * same `model.embed()` the in-process path calls, and the client keeps writing the
 * configured model name into `memory_embeddings.model`, so existing rows stay valid.
 */
export async function startEmbedServer(options: EmbedServerOptions = {}): Promise<EmbedServer> {
	const modelName = options.model ?? currentEmbeddingModel();
	const fastembedName = fastembedModelName(modelName);
	if (fastembedName === null) throw new Error(`embed-serve: no local fastembed model for '${modelName}'`);
	const initializer = options.initializer ?? defaultLocalModelInitializer;

	let loading: Promise<LocalEmbeddingModel> | null = null;
	const load = (): Promise<LocalEmbeddingModel> => {
		if (loading !== null) return loading;
		// A failed load must not poison later requests.
		const attempt: Promise<LocalEmbeddingModel> = initializer({
			model: fastembedName,
			showDownloadProgress: false,
		}).catch((error: unknown) => {
			if (loading === attempt) loading = null;
			throw error;
		});
		loading = attempt;
		return loading;
	};
	// One ONNX session: serialize inference so concurrent clients queue instead of racing it.
	let queue: Promise<unknown> = Promise.resolve();
	const embedSerially = (texts: string[]): Promise<number[][]> => {
		const run = queue.then(async () => drain(await load(), texts));
		queue = run.catch(() => undefined);
		return run;
	};

	const handleEmbeddings = async (request: Request): Promise<Response> => {
		let body: EmbeddingsRequest;
		try {
			body = (await request.json()) as EmbeddingsRequest;
		} catch {
			return errorResponse(400, "request body must be JSON");
		}
		if (body.model !== undefined && body.model !== modelName) {
			return errorResponse(400, `this server serves '${modelName}', not '${String(body.model)}'`);
		}
		const texts = parseInputs(body.input);
		if (texts === null) return errorResponse(400, "'input' must be a string or an array of strings");
		if (texts.length === 0) return json({ object: "list", data: [], model: modelName, usage: {} });
		try {
			const vectors = await embedSerially(texts);
			return json({
				object: "list",
				data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
				model: modelName,
				usage: {},
			});
		} catch (error) {
			return json(
				{ error: { message: error instanceof Error ? error.message : String(error), type: "server_error" } },
				500,
			);
		}
	};

	const server = Bun.serve({
		hostname: options.host ?? EMBED_SERVE_DEFAULT_HOST,
		port: options.port ?? EMBED_SERVE_DEFAULT_PORT,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (request.method === "GET" && pathname === "/health") {
				return json({ status: "ok", model: modelName, loaded: loading !== null });
			}
			if (request.method === "POST" && pathname === "/v1/embeddings") return handleEmbeddings(request);
			return errorResponse(404, `no route for ${request.method} ${pathname}`);
		},
	});
	if (options.preload === true) await load();
	return { url: `http://${server.hostname}:${server.port}/v1`, model: modelName, stop: () => server.stop(true) };
}
