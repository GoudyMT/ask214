import { createHash } from 'node:crypto';

export type RevisionChunk = { id: string; text: string };
export type ContentRevision = { buildDate: string; contentHash: string };

// A deterministic content fingerprint over the corpus chunks - the same chunks always yield the same hash, so
// an unchanged corpus produces an unchanged contentRevision. JSON handles field delimiting (ASCII-safe: no raw
// separator bytes typed through the tools). buildDate is injected (keeps the unit pure/testable).
export function computeContentRevision(
	chunks: RevisionChunk[],
	buildDate: string
): ContentRevision {
	const sorted = [...chunks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const payload = JSON.stringify(sorted.map((c) => [c.id, c.text]));
	const contentHash = createHash('sha256').update(payload).digest('hex');
	return { buildDate, contentHash };
}
