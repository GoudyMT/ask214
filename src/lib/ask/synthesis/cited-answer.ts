// The CitedAnswer contract (anti-phishing). Citations are built ONLY from the retrieved
// chunks the model cited by id; a URL, phone number, or handle the model writes into its prose is NEVER
// promoted to a clickable link - it is flagged inert so the renderer keeps it as plain text. A
// scam-targeted audience must never be handed a clickable link the model invented.

import { stripCitations } from './citation-validation';

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

// The model's own trailing copy of the disclaimer, in the shapes it plausibly writes it (the hyphen may
// come back as an en dash, and the final period may be dropped). Anchored to the END so a mention inside
// the body is untouched.
const TRAILING_DISCLAIMER_RE = new RegExp(
	'\\s*AI[-\\u2013\\u2014 ]generated\\s*[-\\u2013\\u2014]?\\s*verify against the official sources\\.?\\s*$',
	'i'
);

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
	// The citation MARKER is machine syntax, not prose. Rendered verbatim it put 12 characters of hash in
	// front of the reader ("...last 180 days of service [dod_skillbridge:71686373cd68]."), and its hex run
	// tripped the anti-phishing phone pattern below on 104 of the 1878 shipped ids. Attribution is carried
	// by `citations`, which is the verified list the UI links. Stripping here uses the same transform the
	// grounding gate does, so the checked text and the read text are the same string.
	// The prompt tells the model to END with the disclaimer, and this function attaches it unconditionally
	// so it survives a model that forgets. Both firing prints the sentence to the reader twice, back to
	// back. The attached copy is the one that is guaranteed, so the model's trailing copy is dropped.
	const prose = stripCitations(modelText).replace(TRAILING_DISCLAIMER_RE, '').trim();
	return { text: prose, citations, inert: detectInert(prose), disclaimer: DISCLAIMER };
}
