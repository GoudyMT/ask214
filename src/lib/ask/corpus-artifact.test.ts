import { describe, it, expect } from 'vitest';
import { buildCorpusArtifact } from './corpus-artifact';
import { decodeCorpus } from '$lib/corpus';
import type { CorpusChunk } from '$lib/corpus';

const MODEL = 'all-MiniLM-L6-v2';
function chunk(id: string): CorpusChunk {
	return {
		id,
		text: `text ${id}`,
		sourceId: 's',
		sourceTitle: 'S',
		tags: [],
		url: 'https://example.gov/'
	};
}

describe('buildCorpusArtifact', () => {
	it('produces a manifest + Float32 blob that B.decodeCorpus accepts', () => {
		const chunks = [chunk('a'), chunk('b')];
		const vectors = [new Float32Array([3, 4]), new Float32Array([0, 5])]; // dim 2
		const { manifest, embeddingsBuffer } = buildCorpusArtifact(chunks, vectors, MODEL, '1.0');

		expect(manifest.version).toBe('1.0');
		expect(manifest.dim).toBe(2);
		expect(manifest.modelId).toBe(MODEL);
		expect(manifest.chunks).toHaveLength(2);
		expect(embeddingsBuffer.byteLength).toBe(2 * 2 * 4); // 2 chunks x dim 2 x 4 bytes

		// Round-trips through B's codec (the real contract).
		const corpus = decodeCorpus(manifest, embeddingsBuffer, MODEL);
		expect(corpus.chunks.map((c) => c.id)).toEqual(['a', 'b']);
		expect(corpus.embeddings[0]![0]).toBeCloseTo(0.6, 6); // [3,4] normalized
	});

	it('throws on a chunks/vectors length mismatch', () => {
		expect(() => buildCorpusArtifact([chunk('a')], [], MODEL, '1.0')).toThrow();
	});

	it('embeds contentRevision in the manifest when provided', () => {
		const chunks = [chunk('a'), chunk('b')];
		const vectors = [new Float32Array([3, 4]), new Float32Array([0, 5])];
		const rev = { buildDate: '2026-07-08', contentHash: 'a'.repeat(64) };
		const { manifest } = buildCorpusArtifact(chunks, vectors, MODEL, '1.0', rev);
		expect(manifest.contentRevision).toEqual(rev);
	});

	it('omits contentRevision (no undefined key) when it is not provided', () => {
		const { manifest } = buildCorpusArtifact(
			[chunk('a')],
			[new Float32Array([1, 0])],
			MODEL,
			'1.0'
		);
		expect(Object.prototype.hasOwnProperty.call(manifest, 'contentRevision')).toBe(false);
	});

	it('is deterministic: identical inputs yield a byte-identical blob and an equal manifest', () => {
		const chunks = [chunk('a'), chunk('b')];
		const vectors = [new Float32Array([3, 4]), new Float32Array([0, 5])];
		const rev = { buildDate: '2026-07-08', contentHash: 'b'.repeat(64) };
		const a = buildCorpusArtifact(chunks, vectors, MODEL, '1.0', rev);
		const b = buildCorpusArtifact(chunks, vectors, MODEL, '1.0', rev);
		expect(new Uint8Array(a.embeddingsBuffer)).toEqual(new Uint8Array(b.embeddingsBuffer));
		expect(a.manifest).toEqual(b.manifest);
	});
});
