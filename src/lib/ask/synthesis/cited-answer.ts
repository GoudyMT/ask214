// The CitedAnswer contract (anti-phishing, red-team C6). Citations are built ONLY from the retrieved
// chunks the model cited by id; a URL, phone number, or handle the model writes into its prose is NEVER
// promoted to a clickable link - it is flagged inert so the renderer keeps it as plain text. A
// scam-targeted audience must never be handed a clickable link the model invented.

/** A clickable source. Only ever built from a retrieved chunk, never from model prose. */
export interface Citation {
	id: string;
	url: string;
	title: string;
}

export interface CitedAnswer {
	text: string;
	citations: Citation[];
	inert: string[]; // link-like tokens found in the prose - the renderer keeps these plain, non-clickable
	disclaimer: string;
}

/** Always attached; the model is also told to end with this, so it survives a model that forgets. */
export const DISCLAIMER = 'AI-generated - verify against the official sources.';

// Best-effort detection of link-like tokens in the prose so the renderer can keep them inert. This is a
// hint, not the safety boundary - the boundary is that `citations` are built only from retrieved chunks.
const INERT_PATTERNS: RegExp[] = [
	/\b(?:https?:\/\/|www\.)[^\s<>(),;]+/gi, // urls
	/\+?\d[\d().\s-]{6,}\d/g, // phone-like digit runs
	/@[a-z0-9_]{2,}/gi // handles
];

function detectInert(text: string): string[] {
	const found: string[] = [];
	for (const pattern of INERT_PATTERNS) {
		for (const match of text.matchAll(pattern)) found.push(match[0].trim());
	}
	return found;
}

/**
 * Assemble the model's answer with ONLY verified citations + an always-present disclaimer.
 *
 * @param modelText The synthesized answer prose.
 * @param citedIds The chunk ids the model cited.
 * @param retrieved The chunks actually retrieved - the only source of clickable citations.
 * @returns The answer text, its verified citations, inert prose tokens, and the disclaimer.
 */
export function toCitedAnswer(
	modelText: string,
	citedIds: string[],
	retrieved: Citation[]
): CitedAnswer {
	const cited = new Set(citedIds);
	const citations = retrieved
		.filter((c) => cited.has(c.id))
		.map((c) => ({ id: c.id, url: c.url, title: c.title }));
	return { text: modelText, citations, inert: detectInert(modelText), disclaimer: DISCLAIMER };
}
