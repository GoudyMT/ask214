/// <reference lib="webworker" />
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { EmbedRequest, EmbedResponse } from './types';
import { ASK_ERROR } from './errors';

// Self-host both the model and the ORT WASM as same-origin static assets: NO runtime HF-CDN /
// jsDelivr fetch -> connect-src 'self' holds, the query never leaves the device, and the flow works
// offline after the (same-origin) first load. Configure env BEFORE pipeline(). Single-threaded SIMD WASM,
// no cross-origin isolation / COEP. Output is mean-pooled + L2-normalized (384-d).
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = '/models/'; // -> /models/Xenova/all-MiniLM-L6-v2/
// The service worker keeps the model in the app's asset cache, which survives updates. The library's own
// browser cache would hold a second ~23 MB copy, which the worker deletes on every update, so it is off.
env.useBrowserCache = false;
// ORT initializes the wasm backend at load; the guard satisfies the conservative Partial type (were it
// ever absent, the default-CDN wasm fetch is CSP-blocked - fails loud, never a silent leak).
const onnxWasm = env.backends.onnx.wasm;
if (onnxWasm) onnxWasm.wasmPaths = '/wasm/';

const MODEL_REPO = 'Xenova/all-MiniLM-L6-v2';
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
function getExtractor(): Promise<FeatureExtractionPipeline> {
	// The literal 'feature-extraction' picks the FeatureExtractionPipeline overload; the cast pins it
	// (pipeline()'s declared return otherwise collapses to a broad, non-callable union). q8 = corpus dtype.
	// A failed load is not kept: a download dropped part-way would otherwise fail every later question.
	extractorPromise ??= (
		pipeline('feature-extraction', MODEL_REPO, {
			dtype: 'q8'
		}) as Promise<FeatureExtractionPipeline>
	).catch((error: unknown) => {
		extractorPromise = null;
		throw error;
	});
	return extractorPromise;
}

self.onmessage = async (e: MessageEvent<EmbedRequest>) => {
	const { id, text } = e.data;
	try {
		const extractor = await getExtractor();
		const out = await extractor(text, { pooling: 'mean', normalize: true });
		const vector = Float32Array.from(out.data as Float32Array);
		const res: EmbedResponse = { id, ok: true, vector };
		(self as DedicatedWorkerGlobalScope).postMessage(res, [vector.buffer]);
	} catch {
		const res: EmbedResponse = { id, ok: false, code: ASK_ERROR.EMBED };
		(self as DedicatedWorkerGlobalScope).postMessage(res);
	}
};
