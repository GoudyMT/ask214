import { AskError, ASK_ERROR, type AskErrorCode } from './errors';
import type { EmbedRequest, EmbedResponse } from './types';

/**
 * Wrap an embedding Web Worker in a promise-returning `embed(text)`. Correlates responses by an
 * incrementing id (concurrent queries are safe). A worker error response rejects with AskError. The
 * worker itself (model load + inference) is `embed-worker.ts`; this client is model-agnostic + testable
 * with a fake worker.
 */
export function createEmbedder(worker: Worker): (text: string) => Promise<Float32Array> {
	let nextId = 1;
	const pending = new Map<
		number,
		{ resolve: (v: Float32Array) => void; reject: (e: AskError) => void }
	>();

	worker.onmessage = (e: MessageEvent<EmbedResponse>) => {
		const res = e.data;
		const entry = pending.get(res.id);
		if (entry === undefined) return;
		pending.delete(res.id);
		if (res.ok) entry.resolve(res.vector);
		else entry.reject(new AskError((res.code as AskErrorCode) ?? ASK_ERROR.EMBED));
	};

	return (text: string) =>
		new Promise<Float32Array>((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			const req: EmbedRequest = { id, text };
			worker.postMessage(req);
		});
}
