import { describe, it, expect } from 'vitest';
import { statSync } from 'node:fs';
import { CORPUS_BASE, CORPUS_BYTES } from '$lib/ask/asset-cache';

// The Save all question states what a first save downloads, the answer library included, so the size it states
// must be the library files' real size. A new corpus changes it, and this fails until it is stated again.
describe('CORPUS_BYTES', () => {
	it('is the size of the answer library files on disk', () => {
		const onDisk = [`${CORPUS_BASE}.json`, `${CORPUS_BASE}.embeddings.bin`].reduce(
			(sum, path) => sum + statSync(`static${path}`).size,
			0
		);
		expect(CORPUS_BYTES).toBe(onDisk);
	});
});
