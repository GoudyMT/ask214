import { describe, it, expect } from 'vitest';
import { buildCorpusArtifact } from './corpus-artifact';
import { decodeCorpus } from '$lib/corpus';
import type { CorpusChunk } from '$lib/corpus';

const MODEL = 'all-MiniLM-L6-v2';
function chunk(id: string): CorpusChunk {
	return { id, text: `text ${id}`, sourceId: 's', sourceTitle: 'S', tags: [], url: 'u' };
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
});
