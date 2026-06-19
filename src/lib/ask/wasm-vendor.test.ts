import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard (ADR-014): every ORT runtime file vendored into static/wasm/ (the `.wasm` binaries + the `.mjs`
 * glue) must be byte-identical to the file the installed onnxruntime-web ships, so an onnxruntime-web
 * version bump that forgets to re-vendor fails loudly in CI. onnxruntime-web is a TRANSITIVE dep (of
 * @huggingface/transformers) and its package.json is not an exported subpath, so we cannot
 * `require.resolve` it; under pnpm it lives at
 * node_modules/.pnpm/onnxruntime-web@<version>/node_modules/onnxruntime-web/dist - located here by scan.
 *
 * ORT loads the `asyncify` variant at runtime (its `.mjs` glue + `.wasm`); a missing asyncify file 404s
 * mid-load (the failure this guard now prevents - S25). The base `.wasm` is also kept. JSPI-capable
 * browsers may request the `jspi` variant instead - that is deferred to the cross-browser launch gate.
 */
const PNPM = 'node_modules/.pnpm';
const ortPkgDir = existsSync(PNPM)
	? readdirSync(PNPM).find((d) => d.startsWith('onnxruntime-web@'))
	: undefined;
const ortDist = ortPkgDir ? join(PNPM, ortPkgDir, 'node_modules', 'onnxruntime-web', 'dist') : '';
const VENDOR = 'static/wasm';

function vendoredOrtFiles(): string[] {
	return existsSync(VENDOR)
		? readdirSync(VENDOR).filter((f) => f.endsWith('.wasm') || f.endsWith('.mjs'))
		: [];
}

describe('vendored ORT runtime matches the installed onnxruntime-web (ADR-014)', () => {
	it('locates the installed onnxruntime-web dist', () => {
		expect(ortPkgDir, 'onnxruntime-web not found under node_modules/.pnpm').toBeDefined();
		expect(existsSync(ortDist)).toBe(true);
	});

	it('vendors the ORT variant the worker actually loads (base + asyncify glue + wasm)', () => {
		expect(existsSync(VENDOR), 'static/wasm/ must exist - vendor the ORT runtime').toBe(true);
		const files = vendoredOrtFiles();
		expect(files).toContain('ort-wasm-simd-threaded.wasm');
		expect(files).toContain('ort-wasm-simd-threaded.asyncify.mjs');
		expect(files).toContain('ort-wasm-simd-threaded.asyncify.wasm');
	});

	it('every vendored ORT file is byte-identical to the installed dist', () => {
		for (const f of vendoredOrtFiles()) {
			expect(
				readFileSync(join(VENDOR, f)).equals(readFileSync(join(ortDist, f))),
				`${f} differs from onnxruntime-web/dist - re-vendor it`
			).toBe(true);
		}
	});
});
