/**
 * Corpus Retrieval Core data model. The chunk + its citation metadata, the shipped manifest,
 * the decoded in-memory corpus, and the retrieval result / card shapes.
 */

/** One retrievable chunk + everything a citation card needs. */
export type CorpusChunk = {
	id: string; // stable, unique within a corpus version
	text: string; // the ~256-token chunk text (retrieval unit + default excerpt)
	excerpt?: string; // optional display excerpt: produced build-time, truncated by the Ask UI, passed through by retrieval
	sourceId: string; // -> sources.yaml entry (the legal record)
	sourceTitle: string;
	page?: number;
	section?: string;
	tags: string[];
	url: string; // "Open original" link
	/**
	 * Optional W3C TextQuoteSelector over the NORMALIZED captured original. `exact` is a verbatim,
	 * normalized substring of the source; prefix/suffix disambiguate. Produced and validated build-time,
	 * passed through by retrieval (the codec does not guard it), consumed by the later highlight-viewer runtime cycle.
	 */
	anchor?: { exact: string; prefix?: string; suffix?: string };
};

/** The shipped chunk manifest (corpus-v1.0.json); embeddings ride alongside as a binary blob. */
export type CorpusManifest = {
	version: string; // corpus generation, e.g. "1.0"
	dim: number; // embedding dimension (384 for MiniLM / BGE-small)
	modelId: string; // the embedding model that produced the vectors
	chunks: CorpusChunk[]; // index-aligned with the embeddings blob
	/**
	 * Producer-side content-freshness stamp: build date + a content hash over the chunks. Optional - older
	 * corpora omit it, and the decoder ignores it (it is not part of the runtime retrieval contract).
	 */
	contentRevision?: { buildDate: string; contentHash: string };
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

/** Citation-complete card view-model the Ask UI renders. */
export type ResultCard = {
	sourceId: string;
	sourceTitle: string;
	chunkId?: string; // the cited chunk's id -> the source reader highlights the block that matches it
	page?: number;
	section?: string;
	excerpt: string; // chunk.excerpt ?? chunk.text (retrieval passes through; the Ask UI truncates for display)
	url: string;
	score: number;
};
