import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

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
		vi.stubGlobal('self', { postMessage: (message: unknown) => posted.push(message) });
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
		vi.stubGlobal('self', { postMessage: () => {} });
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
