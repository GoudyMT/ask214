// Every citation the model emits must resolve to an id in the ACTUAL retrieved set. A citation to an
// unknown id means the model invented a source (or a query-forged "chunk" slipped past the prompt) -- the
// answer is rejected rather than shown as cited-but-fake.
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
