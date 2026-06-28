import { normalizeText } from './normalize';

/**
 * The chunk-id identity rule. id = `${sourceId}:${sha256(normalizeText(text)).slice(0,12)}`.
 * Content-derived, so re-chunking that does not change a chunk's normalized text keeps its id (the eval
 * mapping + any saved citation survive) and changed text yields a new, diffMerge-detectable id. An
 * intra-source EXACT duplicate is disambiguated by the chunk-assignment step appending `-<n>`; this
 * function returns the base id and the cross-ref validator enforces final uniqueness. Uses Web Crypto
 * (portable: Node 22 + browsers); async because subtle.digest is async.
 */
export async function deriveChunkId(sourceId: string, text: string): Promise<string> {
	const bytes = new TextEncoder().encode(normalizeText(text));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `${sourceId}:${hex.slice(0, 12)}`;
}
