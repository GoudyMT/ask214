import { describe, it, expect, vi } from 'vitest';
import { createEmbedder, createRecoveringEmbed } from './embedder';
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

// A worker whose model or WASM failed to load stays failed - the runtime inside it remembers a failed start -
// so the only recovery is a fresh worker.
describe('createRecoveringEmbed', () => {
	/** Workers made on demand; the first `failing` of them answer every embed with an error. */
	function workers(failing: number) {
		const made: { terminated: boolean }[] = [];
		const make = () => {
			const index = made.length;
			const record = { terminated: false };
			made.push(record);
			const w = {
				onmessage: null as ((e: MessageEvent<EmbedResponse>) => void) | null,
				postMessage(req: EmbedRequest) {
					queueMicrotask(() => {
						const res: EmbedResponse =
							index < failing
								? { id: req.id, ok: false, code: 'E_ASK_EMBED' }
								: { id: req.id, ok: true, vector: new Float32Array([1, 0, 0]) };
						this.onmessage?.({ data: res } as MessageEvent<EmbedResponse>);
					});
				},
				terminate() {
					record.terminated = true;
				}
			};
			return w as unknown as Worker;
		};
		return { make, made };
	}

	it('starts no worker until the first embed', () => {
		const { make, made } = workers(0);
		createRecoveringEmbed(make);
		expect(made).toHaveLength(0);
	});

	it('ends a worker whose embed failed, and embeds the next text in a fresh one', async () => {
		const { make, made } = workers(1);
		const { embed } = createRecoveringEmbed(make);
		await expect(embed('first')).rejects.toBeInstanceOf(AskError);
		await expect(embed('second').then((v) => Array.from(v))).resolves.toEqual([1, 0, 0]);
		expect(made.map((w) => w.terminated)).toEqual([true, false]);
	});

	it('keeps a worker that answers', async () => {
		const { make, made } = workers(0);
		const { embed } = createRecoveringEmbed(make);
		await embed('a');
		await embed('b');
		expect(made.map((w) => w.terminated)).toEqual([false]);
	});

	it('ends the worker on dispose', async () => {
		const { make, made } = workers(0);
		const { embed, dispose } = createRecoveringEmbed(make);
		await embed('a');
		dispose();
		expect(made.map((w) => w.terminated)).toEqual([true]);
	});
});
