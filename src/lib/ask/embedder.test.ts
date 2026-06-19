import { describe, it, expect, vi } from 'vitest';
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

	it('rejects pending requests with AskError when the worker crashes (onerror)', async () => {
		const w = {
			onmessage: null,
			onerror: null as ((e: ErrorEvent) => void) | null,
			onmessageerror: null,
			postMessage() {
				queueMicrotask(() => w.onerror?.({} as ErrorEvent));
			},
			terminate() {}
		};
		const embed = createEmbedder(w as unknown as Worker);
		await expect(embed('x')).rejects.toBeInstanceOf(AskError);
	});

	it('does not time out the cold model-loading embed but bounds a warm one', async () => {
		vi.useFakeTimers();
		let calls = 0;
		const w = {
			onmessage: null as ((e: MessageEvent<EmbedResponse>) => void) | null,
			onerror: null,
			onmessageerror: null,
			postMessage(req: EmbedRequest) {
				calls += 1;
				if (calls === 1) {
					queueMicrotask(() =>
						w.onmessage?.({
							data: { id: req.id, ok: true, vector: new Float32Array([1]) }
						} as MessageEvent<EmbedResponse>)
					);
				}
				// the 2nd request stays silent -> simulates a hung warm embed
			},
			terminate() {}
		};
		const embed = createEmbedder(w as unknown as Worker, 5000);
		await embed('cold'); // model load: no timeout, resolves -> modelReady = true
		const warm = embed('warm'); // warm: 5s timeout armed
		const rejects = expect(warm).rejects.toBeInstanceOf(AskError); // attach handler BEFORE the timer fires
		await vi.advanceTimersByTimeAsync(5000);
		await rejects;
		vi.useRealTimers();
	});

	it('rejects pending requests with AskError when a message is undeserializable (onmessageerror)', async () => {
		const w = {
			onmessage: null,
			onerror: null,
			onmessageerror: null as ((e: MessageEvent) => void) | null,
			postMessage() {
				queueMicrotask(() => w.onmessageerror?.({} as MessageEvent));
			},
			terminate() {}
		};
		const embed = createEmbedder(w as unknown as Worker);
		await expect(embed('x')).rejects.toBeInstanceOf(AskError);
	});

	it('rejects new embeds after the worker dies during cold load, instead of hanging forever', async () => {
		// A crash BEFORE the first success leaves modelReady=false, so the warm-timeout is never armed and
		// a post-crash embed would hang forever (stuck modelLoading). A dead worker must refuse new work.
		const w = {
			onmessage: null,
			onerror: null as ((e: ErrorEvent) => void) | null,
			onmessageerror: null,
			postMessage() {}, // a dead worker never replies
			terminate() {}
		};
		const embed = createEmbedder(w as unknown as Worker);
		w.onerror?.({} as ErrorEvent); // cold-load crash (no successful embed yet)
		await expect(embed('boot')).rejects.toBeInstanceOf(AskError);
	}, 2000);
});
