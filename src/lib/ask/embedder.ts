import { AskError, ASK_ERROR, isAskErrorCode, type AskErrorCode } from './errors';
import type { EmbedRequest, EmbedResponse } from './types';

/**
 * Warm-embed timeout (ms). Once the model has loaded, a reply that never comes is a bug, so we bound it.
 * The first (cold) embed is deliberately NOT timed: the one-time ~23MB model load can legitimately take
 * long on a low-bandwidth Context-1 device, and timing it out would falsely fail a slow-but-progressing
 * download.
 */
const WARM_TIMEOUT_MS = 15_000;

/**
 * Wrap an embedding Web Worker in a promise-returning `embed(text)`. Correlates responses by an
 * incrementing id (concurrent queries are safe). Rejects with AskError on: a worker error response, a
 * worker crash (`onerror`), an undeserializable message (`onmessageerror`), or a warm-embed timeout -
 * so a dead/hung worker never leaves the UI stuck in `embedding`. A crash marks the worker dead, so an
 * embed issued AFTER the crash rejects at once (the cold path arms no timeout, else it would hang). The
 * worker itself (model load +
 * inference) is `embed-worker.ts`; this client is model-agnostic and testable with a fake worker.
 */
export function createEmbedder(
	worker: Worker,
	warmTimeoutMs: number = WARM_TIMEOUT_MS
): (text: string) => Promise<Float32Array> {
	let nextId = 1;
	let modelReady = false; // flips true on the first successful response - the model is loaded + warm
	let dead = false; // set on a worker crash/garble; a dead worker cannot recover, so it must refuse new work
	type Pending = {
		resolve: (v: Float32Array) => void;
		reject: (e: AskError) => void;
		timer: ReturnType<typeof setTimeout> | undefined;
	};
	const pending = new Map<number, Pending>();

	function take(id: number): Pending | undefined {
		const entry = pending.get(id);
		if (entry === undefined) return undefined;
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		pending.delete(id);
		return entry;
	}

	function rejectAll(code: AskErrorCode) {
		dead = true; // the worker is gone: reject in-flight requests AND refuse any new embed (else it hangs)
		for (const id of [...pending.keys()]) take(id)?.reject(new AskError(code));
	}

	worker.onmessage = (e: MessageEvent<EmbedResponse>) => {
		const res = e.data;
		const entry = take(res.id);
		if (entry === undefined) return;
		if (res.ok) {
			modelReady = true;
			entry.resolve(res.vector);
		} else {
			entry.reject(new AskError(isAskErrorCode(res.code) ? res.code : ASK_ERROR.EMBED));
		}
	};
	// A worker crash or an undeserializable message would otherwise hang every pending embed forever.
	worker.onerror = () => rejectAll(ASK_ERROR.MODEL_LOAD);
	worker.onmessageerror = () => rejectAll(ASK_ERROR.EMBED);

	return (text: string) =>
		new Promise<Float32Array>((resolve, reject) => {
			// A crashed worker never replies and (on the cold path) has no timeout armed, so refuse new work.
			if (dead) return reject(new AskError(ASK_ERROR.MODEL_LOAD));
			const id = nextId++;
			const timer = modelReady
				? setTimeout(() => take(id)?.reject(new AskError(ASK_ERROR.EMBED)), warmTimeoutMs)
				: undefined;
			pending.set(id, { resolve, reject, timer });
			const req: EmbedRequest = { id, text };
			worker.postMessage(req);
		});
}

/**
 * Create the embed worker on the first embed, and replace it after an embed fails.
 *
 * A worker whose model or WASM failed to load stays failed: the runtime inside it remembers a failed start, so
 * every later embed would fail until the page is left. Ending that worker, and starting a fresh one for the
 * next embed, lets a retry succeed once the connection is back, and frees whatever half-loaded model it held.
 *
 * @param makeWorker Creates the embed worker.
 * @param wrap Wraps a worker in an embed function; `createEmbedder` by default.
 * @returns `embed`, and `dispose`, which ends the current worker (the page calls it when it is left).
 */
export function createRecoveringEmbed(
	makeWorker: () => Worker,
	wrap: (worker: Worker) => (text: string) => Promise<Float32Array> = createEmbedder
) {
	let worker: Worker | undefined;
	let embedder: ((text: string) => Promise<Float32Array>) | undefined;
	const dispose = () => {
		worker?.terminate();
		worker = undefined;
		embedder = undefined;
	};
	const embed = async (text: string): Promise<Float32Array> => {
		worker ??= makeWorker();
		embedder ??= wrap(worker);
		try {
			return await embedder(text);
		} catch (error) {
			dispose();
			throw error;
		}
	};
	return { embed, dispose };
}
