import type { CorpusChunk, CorpusManifest } from '$lib/corpus';

/**
 * Assemble a shipped corpus artifact (manifest + flat Float32 blob) from chunks + their embedding
 * vectors. Pure - the inverse of B's `decodeCorpus`. The Node embed script and the tests both use it,
 * so "what we ship" and "what B decodes" are the same code path. `dim` is inferred from vector 0.
 */
export function buildCorpusArtifact(
	chunks: CorpusChunk[],
	vectors: Float32Array[],
	modelId: string,
	version: string,
	contentRevision?: { buildDate: string; contentHash: string }
): { manifest: CorpusManifest; embeddingsBuffer: ArrayBuffer } {
	if (chunks.length !== vectors.length) {
		throw new Error('E_ASK_ARTIFACT_LENGTH'); // build-time only, never user-facing
	}
	const dim = vectors[0]?.length ?? 0;
	const flat = new Float32Array(chunks.length * dim);
	for (let i = 0; i < vectors.length; i++) {
		const v = vectors[i];
		if (v === undefined || v.length !== dim) throw new Error('E_ASK_ARTIFACT_DIM');
		flat.set(v, i * dim);
	}
	const manifest: CorpusManifest = { version, dim, modelId, chunks };
	if (contentRevision !== undefined) manifest.contentRevision = contentRevision;
	return { manifest, embeddingsBuffer: flat.buffer };
}
