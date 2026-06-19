import type { Corpus, CorpusManifest } from './types';
import { CorpusFormatError, CorpusVersionError } from './errors';
import { normalize } from './search';

/**
 * Decode + validate a shipped corpus (manifest + flat Float32 embeddings blob) into the in-memory
 * Corpus `search` operates on (spec section 5). Pure: receives already-materialized inputs, does no
 * IO (transport, gzip, integrity-hashing, IndexedDB, CDN are all cycle C's job).
 *
 * Gate order (each throws a typed error with an opaque code - mirrors decodeTimelineState):
 *   1. version (CorpusVersionError)   - a v1.1 corpus on a cached v1.0 client must not silently run
 *   2. modelId (CorpusFormatError)    - the dim check CANNOT catch a model swap (both candidates 384-dim)
 *   3. shape (CorpusFormatError)      - dim a positive int + chunks an array, before the byte arithmetic
 *   4. byte length (CorpusFormatError)- gross corruption / truncation
 *   5. url scheme (CorpusFormatError) - every citation url must be https (no javascript:/data: card hrefs)
 *   6. per-chunk slice + unit-normalize; a zero embedding throws E_CORPUS_ZERO_VECTOR (bad vector)
 */

/** The corpus generation this client build supports. A different version throws (spec 8.6). */
export const ACCEPTED_CORPUS_VERSION = '1.0';

export function decodeCorpus(
	manifest: CorpusManifest,
	embeddingsBuffer: ArrayBuffer,
	expectedModelId: string
): Corpus {
	if (manifest.version !== ACCEPTED_CORPUS_VERSION) {
		throw new CorpusVersionError('E_CORPUS_VERSION');
	}
	if (manifest.modelId !== expectedModelId) {
		throw new CorpusFormatError('E_CORPUS_MODEL');
	}
	const { chunks, dim } = manifest;
	// Gate 3: shape - dim a positive integer + chunks an array, BEFORE the byte arithmetic (a fractional or
	// negative dim could be chosen so chunks.length*dim*4 matches the blob and slip past the length gate).
	if (!Array.isArray(chunks) || !Number.isInteger(dim) || dim <= 0) {
		throw new CorpusFormatError('E_CORPUS_SHAPE');
	}
	const expectedBytes = chunks.length * dim * 4;
	if (embeddingsBuffer.byteLength !== expectedBytes) {
		throw new CorpusFormatError('E_CORPUS_BYTE_LENGTH');
	}
	// Gate 5: every citation url must be https. A non-https (javascript:/data:/http:) url would become a
	// live href in a result card; users cannot author the corpus, so this guards a build error / tampering.
	for (const chunk of chunks) {
		if (!chunk.url.toLowerCase().startsWith('https://')) {
			throw new CorpusFormatError('E_CORPUS_URL');
		}
	}
	const flat = new Float32Array(embeddingsBuffer);
	const embeddings: Float32Array[] = [];
	for (let i = 0; i < chunks.length; i++) {
		embeddings.push(normalize(flat.subarray(i * dim, (i + 1) * dim)));
	}
	return { version: manifest.version, dim, modelId: manifest.modelId, chunks, embeddings };
}
