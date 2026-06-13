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
 * so a dead/hung worker never leaves the UI stuck in `embedding`. The worker itself (model load +
 * inference) is `embed-worker.ts`; this client is model-agnostic and testable with a fake worker.
 */
export function createEmbedder(
	worker: Worker,
	warmTimeoutMs: number = WARM_TIMEOUT_MS
): (text: string) => Promise<Float32Array> {
	let nextId = 1;
	let modelReady = false; // flips true on the first successful response - the model is loaded + warm
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
			const id = nextId++;
			const timer = modelReady
				? setTimeout(() => take(id)?.reject(new AskError(ASK_ERROR.EMBED)), warmTimeoutMs)
				: undefined;
			pending.set(id, { resolve, reject, timer });
			const req: EmbedRequest = { id, text };
			worker.postMessage(req);
		});
}
