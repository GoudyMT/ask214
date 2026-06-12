import { describe, it, expect } from 'vitest';
import { createEmbedder } from './embedder';
import { AskError } from './errors';
import type { EmbedRequest, EmbedResponse } from './types';

// A fake worker: echoes a fixed vector, or an error for the text 'boom'.
function fakeWorker(): Worker {
	const w = {
		onmessage: null as ((e: MessageEvent<EmbedResponse>) => void) | null,
		postMessage(req: EmbedRequest) {
			queueMicrotask(() => {
				const res: EmbedResponse =
					req.text === 'boom'
						? { id: req.id, ok: false, code: 'E_ASK_EMBED' }
						: { id: req.id, ok: true, vector: new Float32Array([1, 0, 0]) };
				this.onmessage?.({ data: res } as MessageEvent<EmbedResponse>);
			});
		},
		terminate() {}
	};
	return w as unknown as Worker;
}

describe('createEmbedder', () => {
	it('resolves embed(text) with the worker vector', async () => {
		const embed = createEmbedder(fakeWorker());
		const v = await embed('hello');
		expect(Array.from(v)).toEqual([1, 0, 0]);
	});

	it('rejects with AskError when the worker reports an error', async () => {
		const embed = createEmbedder(fakeWorker());
		await expect(embed('boom')).rejects.toBeInstanceOf(AskError);
	});

	it('correlates concurrent requests by id', async () => {
		const embed = createEmbedder(fakeWorker());
		const [a, b] = await Promise.all([embed('x'), embed('y')]);
		expect(a.length).toBe(3);
		expect(b.length).toBe(3);
	});
});
