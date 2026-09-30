import { describe, it, expect, vi } from 'vitest';
import { dropOrtWasm, dropWorkerWasm } from './drop-worker-wasm';

const ORT = 'assets/ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm';
const SCRIPT = 'assets/embed-worker-BIZt0I_P.js';

/** Stands in for the bundler's `error`, which ends the build: the code it was given rides out on this. */
class BuildEnded extends Error {
	constructor(readonly code: string) {
		super('E_TEST_BUILD_ENDED');
	}
}

/** A plugin context that records what was warned and ends the build the way the bundler does. */
function context() {
	return {
		warn: vi.fn<(message: string) => void>(),
		error(code: string): never {
			throw new BuildEnded(code);
		}
	};
}

/** The code the build ended with, or `undefined` when it did not end. */
function endedWith(run: () => void): string | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof BuildEnded) return error.code;
		throw error;
	}
	return undefined;
}

describe('dropOrtWasm', () => {
	it('removes the ONNX runtime fallback WASM and keeps the worker script', () => {
		const bundle = {
			[ORT]: { type: 'asset' },
			[SCRIPT]: { type: 'chunk' }
		};
		expect(endedWith(() => dropOrtWasm(bundle, context()))).toBeUndefined();
		expect(Object.keys(bundle)).toEqual([SCRIPT]);
	});

	it('removes each variant of the runtime WASM the library names', () => {
		const bundle = {
			'assets/ort-wasm-simd-threaded-Ab12Cd34.wasm': { type: 'asset' },
			'assets/ort-wasm-simd-threaded.jsep-Ab12Cd34.wasm': { type: 'asset' },
			[SCRIPT]: { type: 'chunk' }
		};
		expect(endedWith(() => dropOrtWasm(bundle, context()))).toBeUndefined();
		expect(Object.keys(bundle)).toEqual([SCRIPT]);
	});

	// A worker that really bundles its own WASM would build green and 404 in production if the drop took it too.
	it('ends the build on any other WASM, with a code that names no file', () => {
		const bundle = {
			[ORT]: { type: 'asset' },
			'assets/codec-Zx81Qw2e.wasm': { type: 'asset' },
			[SCRIPT]: { type: 'chunk' }
		};
		const ctx = context();
		expect(endedWith(() => dropOrtWasm(bundle, ctx))).toBe('E_WORKER_WASM_UNEXPECTED');
		expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining('assets/codec-Zx81Qw2e.wasm'));
	});

	it('does not take a WASM that only has the runtime name inside another name', () => {
		for (const name of [
			'assets/my-ort-wasm-simd-threaded-Ab12Cd34.wasm',
			'assets/ort-wasm-simd-threaded-Ab12Cd34.wasm.txt.wasm',
			'assets/ort-wasm-simd-threaded.wasm'
		]) {
			expect(endedWith(() => dropOrtWasm({ [name]: { type: 'asset' } }, context()))).toBe(
				'E_WORKER_WASM_UNEXPECTED'
			);
		}
	});

	it('leaves a bundle with no WASM untouched', () => {
		const bundle = {
			[SCRIPT]: { type: 'chunk' },
			'assets/style-Q1.css': { type: 'asset' }
		};
		expect(endedWith(() => dropOrtWasm(bundle, context()))).toBeUndefined();
		expect(Object.keys(bundle)).toEqual([SCRIPT, 'assets/style-Q1.css']);
	});
});

describe('dropWorkerWasm', () => {
	// The hook runs with the bundler's plugin context as `this`.
	const hook = dropWorkerWasm().generateBundle as unknown as (
		this: ReturnType<typeof context>,
		options: unknown,
		bundle: Record<string, { type: string }>
	) => void;

	it('is named for what it does, so a build log can say which plugin ended the build', () => {
		expect(dropWorkerWasm().name).toBe('drop-worker-wasm');
	});

	it('drops the runtime WASM from the bundle it is handed', () => {
		const bundle = { [ORT]: { type: 'asset' }, [SCRIPT]: { type: 'chunk' } };
		hook.call(context(), {}, bundle);
		expect(Object.keys(bundle)).toEqual([SCRIPT]);
	});

	it('ends the build through the context on another WASM', () => {
		expect(
			endedWith(() => hook.call(context(), {}, { 'assets/codec-Zx81Qw2e.wasm': { type: 'asset' } }))
		).toBe('E_WORKER_WASM_UNEXPECTED');
	});
});
