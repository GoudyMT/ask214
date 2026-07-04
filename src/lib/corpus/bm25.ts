// v1.1 LEVER - built + tested, NOT on the v1.0 dense retrieval path. Deferred per the A4 charter Measured
// Result (BM25 did not improve ranking at the client-shippable scale; the tuner rejected the lexical gate).
// Kept for the v1.1 exact-term / form-number + correct-empty work. Imported only by the eval + tests.
/**
 * Okapi BM25 lexical scoring over the corpus chunk texts. Pure + dependency-free. Used alongside the dense
 * cosine search in the hybrid retriever: BM25 grounds relevance in actual keyword overlap, so an off-corpus
 * query (no shared terms) scores 0 on every chunk - the signal the hybrid uses to correctly return nothing.
 * Also rewards exact-term matches (acronyms, form numbers) that dense embeddings blur together.
 */

const K1 = 1.5; // term-frequency saturation
const B = 0.75; // document-length normalization

/** Lowercase + split on non-alphanumerics, keeping acronyms + digit runs (DD214, 526ez, 21, 1606) as terms. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 0);
}

export type Bm25Index = {
	docCount: number;
	avgDocLen: number;
	docLens: number[];
	postings: Map<string, Map<number, number>>; // term -> (docIndex -> term frequency)
	idf: Map<string, number>;
};

export function buildBm25Index(docTexts: string[]): Bm25Index {
	const docCount = docTexts.length;
	const docLens: number[] = [];
	const postings = new Map<string, Map<number, number>>();
	for (const [i, text] of docTexts.entries()) {
		const terms = tokenize(text);
		docLens.push(terms.length);
		for (const term of terms) {
			let docMap = postings.get(term);
			if (docMap === undefined) {
				docMap = new Map<number, number>();
				postings.set(term, docMap);
			}
			docMap.set(i, (docMap.get(i) ?? 0) + 1);
		}
	}
	const totalLen = docLens.reduce((a, b) => a + b, 0);
	const avgDocLen = docCount === 0 ? 0 : totalLen / docCount;
	// The 1 + (...) form keeps IDF non-negative even for a term present in every doc.
	const idf = new Map<string, number>();
	for (const [term, docMap] of postings) {
		const df = docMap.size;
		idf.set(term, Math.log(1 + (docCount - df + 0.5) / (df + 0.5)));
	}
	return { docCount, avgDocLen, docLens, postings, idf };
}

/** BM25 score per document (aligned to the buildBm25Index doc order). Docs sharing no query term stay 0. */
export function bm25Scores(query: string, index: Bm25Index): number[] {
	const scores = new Array<number>(index.docCount).fill(0);
	const queryTerms = new Set(tokenize(query));
	const avgdl = index.avgDocLen || 1;
	for (const term of queryTerms) {
		const docMap = index.postings.get(term);
		if (docMap === undefined) continue; // term not in corpus -> contributes nothing
		const idf = index.idf.get(term) ?? 0;
		for (const [docIndex, tf] of docMap) {
			const len = index.docLens[docIndex] ?? 0;
			const denom = tf + K1 * (1 - B + (B * len) / avgdl);
			scores[docIndex] = (scores[docIndex] ?? 0) + (idf * (tf * (K1 + 1))) / denom;
		}
	}
	return scores;
}
