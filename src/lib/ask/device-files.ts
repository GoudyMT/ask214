import { ASK_ASSET_CACHE, CORPUS_BASE } from './asset-cache';

/**
 * Every file an on-device answer needs, as the service worker keeps them: the search model, the runtime that runs
 * it, and the answer library. The model and runtime paths are written out rather than read from the vendored
 * manifest, so the page does not carry the manifest's hashes; tests hold this list to the manifest, to the files
 * the app ships, and - end to end - to exactly what a real setup stores.
 */
export const DEVICE_FILES: readonly string[] = [
	'/models/Xenova/all-MiniLM-L6-v2/config.json',
	'/models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json',
	'/models/Xenova/all-MiniLM-L6-v2/tokenizer.json',
	'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
	'/wasm/ort-wasm-simd-threaded.asyncify.mjs',
	'/wasm/ort-wasm-simd-threaded.asyncify.wasm',
	`${CORPUS_BASE}.json`,
	`${CORPUS_BASE}.embeddings.bin`
];

/**
 * Whether this device keeps every file an on-device answer needs, read from the cache itself.
 *
 * A remembered "downloaded" flag drifted from the cache: a download made before the service worker took charge, a
 * write that failed on a full disk, and files the browser later deleted all left it claiming a model that was not
 * there - and the next question downloaded the model again without asking. The cache is the fact.
 *
 * @param cachesApi The browser's CacheStorage; undefined where it has none.
 * @returns true only when every file is kept; false otherwise, including when the cache cannot be read.
 */
export async function deviceFilesKept(cachesApi: CacheStorage | undefined): Promise<boolean> {
	try {
		if (cachesApi === undefined) return false;
		for (const path of DEVICE_FILES) {
			// cacheName looks in the asset cache alone, and a missing cache reads as missing - never created.
			const options = { cacheName: ASK_ASSET_CACHE, ignoreVary: true };
			if ((await cachesApi.match(path, options)) === undefined) return false;
		}
		return true;
	} catch {
		// A cache the browser will not open (a private mode, a storage error) keeps nothing to count on.
		return false;
	}
}
