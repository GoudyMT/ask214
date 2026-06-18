import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Integrity guard (design spec section 12, sweep M-c): the self-hosted MiniLM model files (ADR-014) are
 * the feature's novel supply-chain surface - committed binaries with no installed package to diff against
 * (unlike the ORT wasm, guarded byte-for-byte in wasm-vendor.test.ts). A committed SHA-256 manifest pins
 * their exact bytes: any change to a model file must deliberately update the manifest (a review
 * checkpoint), and CI catches silent drift or a corrupted/swapped model.
 */
const MODEL_DIR = 'static/models/Xenova/all-MiniLM-L6-v2';
const MANIFEST = 'src/lib/ask/model-vendor.manifest.json'; // committed expected hashes; not served

const MODEL_FILES = [
	'config.json',
	'tokenizer_config.json',
	'tokenizer.json',
	'onnx/model_quantized.onnx'
];

function sha256(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('self-hosted model integrity (SHA-256 manifest, spec section 12)', () => {
	it('commits a manifest covering exactly the self-loaded model files', () => {
		expect(existsSync(MANIFEST), `${MANIFEST} missing - generate the model SHA-256 manifest`).toBe(
			true
		);
		const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, string>;
		expect(Object.keys(manifest).sort()).toEqual([...MODEL_FILES].sort());
	});

	it('every committed model file is byte-identical to its manifest hash', () => {
		const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, string>;
		for (const rel of MODEL_FILES) {
			const file = join(MODEL_DIR, rel);
			expect(existsSync(file), `${rel} missing from ${MODEL_DIR}`).toBe(true);
			expect(sha256(file), `${rel} bytes differ from the manifest - re-vendor or update it`).toBe(
				manifest[rel]?.toLowerCase()
			);
		}
	});
});
