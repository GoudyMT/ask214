function wordTrigrams(text: string): Set<string> {
	const words = text
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 0);
	const grams = new Set<string>();
	for (let i = 0; i + 2 < words.length; i++) grams.add(words.slice(i, i + 3).join(' '));
	return grams;
}

/**
 * Word-trigram Jaccard similarity (0-1) used as a cross-tool agreement metric. Two extractions of the
 * same PDF (e.g. pdfjs vs poppler) with high overlap means both tools independently agree on the content
 * AND local word order (a strong fidelity signal); low overlap means they disagree (dropped / garbled /
 * reordered) and the source should be flagged for human review. Whitespace-independent (operates on
 * words). Pure.
 */
export function trigramSimilarity(a: string, b: string): number {
	const ga = wordTrigrams(a);
	const gb = wordTrigrams(b);
	if (ga.size === 0 && gb.size === 0) return 1;
	if (ga.size === 0 || gb.size === 0) return 0;
	let inter = 0;
	for (const g of ga) if (gb.has(g)) inter++;
	return inter / (ga.size + gb.size - inter);
}
