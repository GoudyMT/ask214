// Every citation the model emits must resolve to an id in the ACTUAL retrieved set. A citation to an
// unknown id means the model invented a source (or a query-forged "chunk" slipped past the prompt) -- the
// answer is rejected rather than shown as cited-but-fake.
//
// The citation MARKER shape lives here too, so the three consumers cannot drift apart: the parser that
// extracts cited ids, the numeric-grounding basis, and the prose the user reads. They were separate, and
// every one of them was wrong in a different way - grounding read the marker's hex as a numeric claim, the
// rendered answer showed 12 characters of hash to the user, and the anti-phishing detector read a run of
// hex digits as a phone number.

/**
 * The bracketed citation marker the prompt asks the model to emit, e.g. `[dod_skillbridge:89e8cdda8199]`.
 * A chunk id is `<sourceId>:<12 hex>` and may carry a `-<n>` collision suffix, so the colon and hyphen are
 * both required members of the class. The colon was missing, which made no real id parseable and left the
 * whole synthesis feature inert in production.
 *
 * Deliberately a permissive character set rather than the exact id shape: a marker that parses but is not
 * a retrieved id fails loudly through `validateCitations`. Note this still has a SILENT-ZERO mode - a
 * shape the class cannot read at all (`[idA, idB]`, `[Source: idA]`) yields no citations, which is
 * indistinguishable from a model that cited nothing.
 *
 * Case-insensitive, so a made-up marker in any case (`[DOD_SKILLBRIDGE:ABCDEFABCDEF]`) still parses and
 * fails `validateCitations`, which compares ids exactly. The one exemption is a bracket the sources print
 * themselves ("Transfer of Entitlement [TOE]"): read as a citation it names no retrieved id, and an answer
 * that merely quoted its source was refused. See `printedAcronyms`.
 */
export const CITATION = /\[([a-z0-9_.:-]+)\]/gi;

// The shape of a bracket that may be an acronym: capital letters only, in exactly that case.
const ACRONYM = /^[A-Z]+$/;

/**
 * Collect the acronym brackets the retrieved sources print.
 *
 * Only a bracket the sources themselves print is exempt from being read as a citation. A capital-letters
 * bracket that no source prints (`[DOD]`, `[VABENEFITSGUIDE]`) is a made-up source and stays a citation, so
 * it fails `validateCitations`. Pass the result to `parseCitedIds`, `stripCitations` and `toCitedAnswer`
 * alike, so the gate and the text the reader sees agree on which brackets are acronyms.
 *
 * Args:
 *     texts: The cleaned text of every retrieved chunk.
 *
 * Returns:
 *     The contents of each capital-letters bracket printed in any of the texts, brackets excluded.
 */
export function printedAcronyms(texts: readonly string[]): Set<string> {
	const printed = new Set<string>();
	for (const text of texts) {
		for (const match of text.matchAll(CITATION)) {
			const id = match[1];
			if (id && ACRONYM.test(id)) printed.add(id);
		}
	}
	return printed;
}

/**
 * Extract the chunk ids the model cited.
 *
 * Args:
 *     text: The model's raw answer text.
 *     printed: The acronym brackets the sources print (`printedAcronyms`); none by default, so every
 *         bracket is read as a citation.
 *
 * Returns:
 *     The unique cited ids, in first-seen order.
 */
export function parseCitedIds(text: string, printed: ReadonlySet<string> = new Set()): string[] {
	const ids = new Set<string>();
	for (const match of text.matchAll(CITATION)) {
		const id = match[1];
		if (id && !printed.has(id)) ids.add(id);
	}
	return [...ids];
}

/**
 * Remove the citation markers, leaving the prose a reader actually sees.
 *
 * The marker is REMOVED, never replaced with a space. A space separates, which lets a fabricated figure be
 * spliced across valid markers and tokenized into grounded fragments ("2[id]0[id]2[id]5" -> "2 0 2 5",
 * four single digits almost any source contains). Removal reassembles the figure so the grounding gate
 * checks the number the reader ends up with.
 *
 * Args:
 *     text: The model's raw answer text.
 *     printed: The acronym brackets the sources print (`printedAcronyms`); these stay in the text.
 *
 * Returns:
 *     The text with every citation marker removed and surrounding whitespace tidied.
 */
export function stripCitations(text: string, printed: ReadonlySet<string> = new Set()): string {
	return text
		.replace(CITATION, (marker, id: string) => (printed.has(id) ? marker : ''))
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/[ \t]+([.,;:!?])/g, '$1')
		.trim();
}
export interface CitationCheck {
	ok: boolean;
	invalidIds: string[];
}

/**
 * Confirm every cited chunk id was actually retrieved.
 *
 * @param citedIds Chunk ids the model cited.
 * @param retrievedIds The ids actually returned by retrieval.
 * @returns ok=true only when no cited id is outside the retrieved set.
 */
export function validateCitations(citedIds: string[], retrievedIds: Set<string>): CitationCheck {
	const invalidIds = citedIds.filter((id) => !retrievedIds.has(id));
	return { ok: invalidIds.length === 0, invalidIds };
}
