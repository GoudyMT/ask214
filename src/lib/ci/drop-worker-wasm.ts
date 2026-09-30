import type { Plugin } from 'vite';

// The file name the bundler gives the ONNX runtime's own WASM: the library's name, an optional variant
// (`.asyncify`, `.jsep`), a hash, and `.wasm`. Anything else - a different prefix, no hash - is not that file.
const ORT_WASM_NAME = /^ort-wasm-simd-threaded(?:\.\w+)*-[\w-]{6,}\.wasm$/;

/**
 * Remove the ONNX runtime's fallback WASM from a worker bundle, and fail on any other WASM.
 *
 * The embed worker sets `wasmPaths = '/wasm/'`, so the ONNX runtime loads its WASM from the vendored folder.
 * The runtime library inside the worker also names its own WASM as a fallback for when `wasmPaths` is unset,
 * and the bundler writes that ~23 MB file beside the worker's script, where nothing ever requests it. That one
 * file is dropped. The fallback URL left in the worker then points at a file that does not exist, which is
 * acceptable: it is read only when `wasmPaths` is unset, and a missing WASM must fail loudly (see
 * embed-worker.ts) rather than load a copy nobody vendored.
 *
 * Only that file is dropped. A worker that really bundles its own WASM would otherwise build green and then
 * 404 in production, so any other `.wasm` asset ends the build instead.
 *
 * @param bundle The worker bundle's output, keyed by file name; matching assets are deleted from it.
 * @param context The bundler's plugin context: `warn` carries the file names, which the error code itself leaves
 *   out, and `error` ends the build and must not return.
 */
export function dropOrtWasm(
	bundle: Record<string, { type: string }>,
	context: { warn: (message: string) => void; error: (code: string) => never }
): void {
	const wasm = Object.entries(bundle)
		.filter(([name, file]) => file.type === 'asset' && name.endsWith('.wasm'))
		.map(([name]) => name);
	const foreign = wasm.filter((name) => !ORT_WASM_NAME.test(name.slice(name.lastIndexOf('/') + 1)));
	if (foreign.length > 0) {
		context.warn(`a worker bundle wrote a WASM it does not know: ${foreign.join(', ')}`);
		context.error('E_WORKER_WASM_UNEXPECTED');
	}
	for (const name of wasm) delete bundle[name];
}

/** The worker bundle plugin that applies {@link dropOrtWasm} to each worker bundle as it is generated. */
export function dropWorkerWasm(): Plugin {
	return {
		name: 'drop-worker-wasm',
		generateBundle(_options, bundle) {
			dropOrtWasm(bundle, this);
		}
	};
}
