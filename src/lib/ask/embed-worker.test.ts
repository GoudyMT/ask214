import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { isStall, STALL_MS } from '../net/stall-guard';

// The worker keeps its model pipeline once loaded. A load that fails - a download dropped part-way - must not
// be kept: the next question has to try again, or on-device answers stay broken until the page is left.
const { pipeline, env } = vi.hoisted(() => ({
	pipeline: vi.fn(),
	env: { backends: { onnx: { wasm: {} } } } as Record<string, unknown>
}));

vi.mock('@huggingface/transformers', () => ({ pipeline, env }));

type WorkerScope = { onmessage: (event: { data: { id: number; text: string } }) => Promise<void> };

describe('embed worker', () => {
	const posted: unknown[] = [];

	beforeEach(async () => {
		vi.resetModules();
		posted.length = 0;
		pipeline.mockReset();
		// A worker scope always has a fetch; the library is mocked here, so it is never called.
		vi.stubGlobal('self', {
			postMessage: (message: unknown) => posted.push(message),
			fetch: vi.fn()
		});
		await import('./embed-worker');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function ask(id: number): Promise<void> {
		await (globalThis.self as unknown as WorkerScope).onmessage({ data: { id, text: 'hello' } });
	}

	it('loads the model again after a failed load', async () => {
		const extractor = vi.fn(async () => ({ data: new Float32Array([1, 0]) }));
		pipeline.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(extractor);

		await ask(1);
		await ask(2);

		expect(pipeline).toHaveBeenCalledTimes(2);
		expect(posted[0]).toMatchObject({ id: 1, ok: false });
		expect(posted[1]).toMatchObject({ id: 2, ok: true });
	});

	// The service worker keeps the model in the app's own asset cache, which survives updates. The library's
	// own browser cache would hold a second ~23 MB copy - and the worker deletes every other cache on each
	// update, so that copy would be downloaded again after every one.
	it("keeps the model in the service worker's cache only, not a second cache of the library's own", () => {
		expect(env.useBrowserCache).toBe(false);
	});

	it('keeps a loaded model for every later question', async () => {
		const extractor = vi.fn(async () => ({ data: new Float32Array([1, 0]) }));
		pipeline.mockResolvedValue(extractor);

		await ask(1);
		await ask(2);

		expect(pipeline).toHaveBeenCalledTimes(1);
		expect(posted).toHaveLength(2);
	});
});

// The first setup downloads the model and the runtime (about 23 MB each) through this worker's fetch. A connection that
// is up but silent never fails by itself, so without a bound the first question would wait for good; a slow link that
// keeps delivering must still finish.
describe('embed worker downloads', () => {
	const network = vi.fn();

	beforeEach(async () => {
		vi.resetModules();
		network.mockReset();
		// The library's own copy, as it takes one when it loads: the network fetch itself.
		env.fetch = network;
		vi.stubGlobal('self', { postMessage: () => {}, fetch: network });
		await import('./embed-worker');
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	const workerFetch = () => (globalThis.self as unknown as { fetch: typeof fetch }).fetch;

	/** A body that sends `count` pieces, one every `gapMs`, then ends; it errors when `signal` aborts. */
	function dripping(count: number, gapMs: number, signal: AbortSignal): Response {
		let sent = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					signal.addEventListener('abort', () => {
						clearTimeout(timer);
						controller.error(new DOMException('aborted', 'AbortError'));
					});
					const next = () => {
						timer = setTimeout(() => {
							controller.enqueue(new Uint8Array([65]));
							if (++sent === count) controller.close();
							else next();
						}, gapMs);
					};
					next();
				}
			})
		);
	}

	it('gives a download up, and stops it, once nothing has arrived for the stall bound', async () => {
		vi.useFakeTimers();
		let seen: AbortSignal | undefined;
		network.mockImplementation(
			(_input: unknown, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					seen = init.signal ?? undefined;
					seen?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				})
		);
		const settled = vi.fn();
		const download = workerFetch()('/wasm/ort-wasm-simd-threaded.asyncify.wasm').then(
			() => settled('resolved'),
			(error: unknown) => settled(isStall(error) ? 'stalled' : 'other')
		);

		await vi.advanceTimersByTimeAsync(STALL_MS - 1);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await download;
		expect(settled).toHaveBeenCalledWith('stalled');
		expect(seen?.aborted).toBe(true);
	});

	it('passes a slow download through whole while it keeps arriving', async () => {
		vi.useFakeTimers();
		network.mockImplementation((_input: unknown, init: RequestInit) =>
			Promise.resolve(dripping(4, STALL_MS - 1, init.signal as AbortSignal))
		);
		const text = workerFetch()('/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx').then(
			(response) => response.text()
		);
		await vi.advanceTimersByTimeAsync(4 * STALL_MS);
		expect(await text).toBe('AAAA');
	});

	// The libraries ask with their own options (credentials, headers) and may stop a download themselves.
	it("keeps the caller's options and its own stop", async () => {
		network.mockImplementation(
			(_input: unknown, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
				})
		);
		const stop = new AbortController();
		const download = workerFetch()('/wasm/x.wasm', {
			credentials: 'same-origin',
			signal: stop.signal
		}).catch((error: unknown) => error);
		stop.abort();

		expect((network.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
		const error = await download;
		expect(isStall(error)).toBe(false);
		expect((error as Error).name).toBe('AbortError');
		expect(network.mock.calls[0]?.[0]).toBe('/wasm/x.wasm');
		expect(network.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' });
	});

	// The library keeps its own copy of fetch, taken when it loads - before this worker's code runs - and downloads the
	// model files with that copy, so the bound must reach the library's copy too, not only the worker's global.
	it("bounds the library's own downloads, the model files among them", async () => {
		vi.useFakeTimers();
		network.mockImplementation(
			(_input: unknown, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
				})
		);
		const settled = vi.fn();
		// The library asks with its own options and no stop of its own.
		const libraryFetch = env.fetch as typeof fetch;
		void libraryFetch('/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx', {
			headers: {}
		}).then(
			() => settled('resolved'),
			(error: unknown) => settled(isStall(error) ? 'stalled' : 'other')
		);
		await vi.advanceTimersByTimeAsync(STALL_MS);
		expect(settled).toHaveBeenCalledWith('stalled');
	});
});

// A worker has no content-security-policy header of its own - the page's does not reach it - so nothing but these two
// settings keeps the runtime and the model from being fetched from a CDN. A lost line would break nothing visibly:
// the library's own defaults load from jsDelivr and the Hugging Face hub, and the question would still be answered.
describe('embed worker environment', () => {
	const LIBRARY_WASM_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.0.0/dist/';

	beforeEach(async () => {
		vi.resetModules();
		pipeline.mockReset();
		// The library's defaults at module load: the runtime from a CDN, the model allowed to come from a remote hub.
		(env.backends as { onnx: { wasm: { wasmPaths?: string } } }).onnx.wasm.wasmPaths =
			LIBRARY_WASM_PATH;
		env.allowRemoteModels = true;
		vi.stubGlobal('self', { postMessage: () => {}, fetch: vi.fn() });
		await import('./embed-worker');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('loads the runtime from the app itself, replacing the library default', () => {
		const { wasm } = (env.backends as { onnx: { wasm: { wasmPaths?: string } } }).onnx;
		expect(wasm.wasmPaths).toBe('/wasm/');
	});

	it('never fetches a model from a remote hub', () => {
		expect(env.allowRemoteModels).toBe(false);
		expect(env.localModelPath).toBe('/models/');
	});
});
