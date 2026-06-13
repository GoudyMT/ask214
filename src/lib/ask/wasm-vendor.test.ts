import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard (ADR-014): every ORT WASM vendored into static/wasm/ must be byte-identical to the file the
 * installed onnxruntime-web ships, so an onnxruntime-web version bump that forgets to re-vendor fails
 * loudly in CI. onnxruntime-web is a TRANSITIVE dep (of @huggingface/transformers) and its package.json
 * is not an exported subpath, so we cannot `require.resolve` it; under pnpm it lives at
 * node_modules/.pnpm/onnxruntime-web@<version>/node_modules/onnxruntime-web/dist - located here by scan.
 * (The project is pnpm-pinned; a layout that breaks this scan failing the test is the intended signal.)
 */
const PNPM = 'node_modules/.pnpm';
const ortPkgDir = existsSync(PNPM)
	? readdirSync(PNPM).find((d) => d.startsWith('onnxruntime-web@'))
	: undefined;
const ortDist = ortPkgDir ? join(PNPM, ortPkgDir, 'node_modules', 'onnxruntime-web', 'dist') : '';
const VENDOR = 'static/wasm';

function vendoredWasm(): string[] {
	return existsSync(VENDOR) ? readdirSync(VENDOR).filter((f) => f.endsWith('.wasm')) : [];
}

describe('vendored ORT WASM matches the installed onnxruntime-web (ADR-014)', () => {
	it('locates the installed onnxruntime-web dist', () => {
		expect(ortPkgDir, 'onnxruntime-web not found under node_modules/.pnpm').toBeDefined();
		expect(existsSync(ortDist)).toBe(true);
	});

	it('vendors at least the base SIMD wasm into static/wasm/', () => {
		expect(existsSync(VENDOR), 'static/wasm/ must exist - vendor the ORT wasm').toBe(true);
		expect(vendoredWasm()).toContain('ort-wasm-simd-threaded.wasm');
	});

	it('every vendored .wasm is byte-identical to the installed dist', () => {
		for (const f of vendoredWasm()) {
			expect(
				readFileSync(join(VENDOR, f)).equals(readFileSync(join(ortDist, f))),
				`${f} differs from onnxruntime-web/dist - re-vendor it`
			).toBe(true);
		}
	});
});
