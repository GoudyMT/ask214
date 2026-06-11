import { CorpusFormatError } from './errors';
import type { Corpus, RetrievalResult } from './types';

/**
 * Vector math + cosine top-k search for the retrieval core (spec sections 6). Pure + deterministic.
 * Owns `normalize` (the codec reuses it to pre-normalize corpus embeddings).
 */

/** L2-normalize to a unit vector. A zero-magnitude vector cannot be normalized -> CorpusFormatError. */
export function normalize(v: Float32Array | number[]): Float32Array {
	let sumSq = 0;
	for (let i = 0; i < v.length; i++) {
		const x = v[i];
		if (x === undefined) break;
		sumSq += x * x;
	}
	const mag = Math.sqrt(sumSq);
	if (mag === 0) throw new CorpusFormatError('E_CORPUS_ZERO_VECTOR');
	const out = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) {
		const x = v[i];
		if (x === undefined) break;
		out[i] = x / mag;
	}
	return out;
}

/** Dot product of two equal-length vectors. */
function dot(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const ai = a[i];
		const bi = b[i];
		if (ai === undefined || bi === undefined) break;
		sum += ai * bi;
	}
	return sum;
}

/** Cosine similarity of two vectors (normalizes both internally). */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
	return dot(normalize(a), normalize(b));
}

/**
 * Top-k chunks by cosine similarity to the query embedding. Corpus embeddings are pre-normalized
 * (the codec), so a hit's score is `dot(normalize(query), embedding)`. Deterministic: V8's sort is
 * stable, and `.map` preserves chunk order, so equal scores keep their original (index) order.
 */
export function search(
	queryEmbedding: Float32Array | number[],
	corpus: Corpus,
	k: number
): RetrievalResult[] {
	if (queryEmbedding.length !== corpus.dim) {
		throw new CorpusFormatError('E_CORPUS_QUERY_DIM');
	}
	if (k <= 0 || corpus.chunks.length === 0) return [];
	const q = normalize(queryEmbedding);
	const scored: RetrievalResult[] = [];
	for (let i = 0; i < corpus.embeddings.length; i++) {
		const emb = corpus.embeddings[i];
		const ch = corpus.chunks[i];
		if (emb === undefined || ch === undefined) break;
		scored.push({ chunk: ch, score: dot(q, emb) });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, k);
}
