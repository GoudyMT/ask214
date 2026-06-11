import { describe, it, expect } from 'vitest';
import { normalize, cosineSimilarity, search } from './search';
import { CorpusFormatError } from './errors';
import type { Corpus, CorpusChunk } from './types';

describe('normalize', () => {
	it('scales a vector to unit length', () => {
		const u = normalize(new Float32Array([3, 4])); // magnitude 5
		expect(u[0]).toBeCloseTo(0.6, 6);
		expect(u[1]).toBeCloseTo(0.8, 6);
		const mag = Math.sqrt(u[0]! * u[0]! + u[1]! * u[1]!);
		expect(mag).toBeCloseTo(1, 6);
	});

	it('throws on a zero-magnitude vector (cannot normalize)', () => {
		expect(() => normalize(new Float32Array([0, 0, 0]))).toThrow(CorpusFormatError);
	});
});

describe('cosineSimilarity', () => {
	it('is 1 for identical directions', () => {
		expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
	});

	it('is 0 for orthogonal vectors', () => {
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
	});

	it('is -1 for opposite directions', () => {
		expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 6);
	});
});

function chunk(id: string): CorpusChunk {
	return { id, text: `text ${id}`, sourceId: 's', sourceTitle: 'S', tags: [], url: 'u' };
}

// Corpus embeddings are pre-normalized unit vectors (the codec guarantees this); search dot-products
// the normalized query against them. Here we hand-build a tiny normalized corpus.
const unit = (v: number[]) => normalize(new Float32Array(v));
const CORPUS: Corpus = {
	version: '1.0',
	dim: 2,
	modelId: 'test',
	chunks: [chunk('a'), chunk('b'), chunk('c')],
	embeddings: [unit([1, 0]), unit([0.7071, 0.7071]), unit([0, 1])]
};

describe('search', () => {
	it('returns the top-k chunks by cosine similarity, descending', () => {
		const results = search([1, 0], CORPUS, 2); // closest to chunk a, then b
		expect(results.map((r) => r.chunk.id)).toEqual(['a', 'b']);
		expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
		expect(results[0]!.score).toBeCloseTo(1, 6);
	});

	it('returns all chunks (sorted) when k exceeds the corpus size', () => {
		const results = search([1, 0], CORPUS, 99);
		expect(results.map((r) => r.chunk.id)).toEqual(['a', 'b', 'c']);
	});

	it('returns [] for an empty corpus', () => {
		const empty: Corpus = { ...CORPUS, chunks: [], embeddings: [] };
		expect(search([1, 0], empty, 5)).toEqual([]);
	});

	it('returns [] when k <= 0', () => {
		expect(search([1, 0], CORPUS, 0)).toEqual([]);
	});

	it('throws when the query dim does not match the corpus dim', () => {
		expect(() => search([1, 0, 0], CORPUS, 2)).toThrow(CorpusFormatError);
	});
});
