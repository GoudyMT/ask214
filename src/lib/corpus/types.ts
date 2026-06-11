/**
 * Corpus Retrieval Core (B) data model. The chunk + its citation metadata, the shipped manifest,
 * the decoded in-memory corpus, and the retrieval result / card shapes.
 *
 * Source: Corpus Retrieval Core design spec (2026-06-09).
 */

/** One retrievable chunk + everything a citation card needs. */
export type CorpusChunk = {
	id: string; // stable, unique within a corpus version
	text: string; // the ~500-token chunk text (retrieval unit + default excerpt)
	excerpt?: string; // optional display excerpt: PRODUCED by A, truncated by C, passed through by B
	sourceId: string; // -> sources.yaml entry (the legal record, spec 8.1)
	sourceTitle: string;
	page?: number;
	section?: string;
	tags: string[];
	url: string; // "Open original" link
};

/** The shipped chunk manifest (corpus-v1.0.json); embeddings ride alongside as a binary blob. */
export type CorpusManifest = {
	version: string; // corpus generation, e.g. "1.0"
	dim: number; // embedding dimension (384 for MiniLM / BGE-small)
	modelId: string; // the embedding model that produced the vectors
	chunks: CorpusChunk[]; // index-aligned with the embeddings blob
};

/** The decoded, validated, in-memory corpus `search` operates on. */
export type Corpus = {
	version: string;
	dim: number;
	modelId: string;
	chunks: CorpusChunk[];
	embeddings: Float32Array[]; // PRE-NORMALIZED unit vectors, index-aligned with chunks
};

/** One scored hit. score = cosine similarity in [-1, 1]. */
export type RetrievalResult = {
	chunk: CorpusChunk;
	score: number;
};

/** Citation-complete card view-model the Ask UI (C) renders. */
export type ResultCard = {
	sourceId: string;
	sourceTitle: string;
	page?: number;
	section?: string;
	excerpt: string; // chunk.excerpt ?? chunk.text (B passes through; C truncates for display)
	url: string;
	score: number;
};
