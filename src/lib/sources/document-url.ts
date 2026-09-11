import { DOCUMENT_URLS } from './document-urls.data';

/**
 * The url of the document a chunk was taken from, anchored to the cited page.
 *
 * PDF sources all share one TAP library url in the registry, so a citation built from `chunk.url` lands
 * the reader on a directory listing 21 documents rather than on the one they asked about. This resolves
 * the document itself and points at the page the passage is on.
 *
 * @param sourceId The chunk's source id.
 * @param page The chunk's 1-based physical page, when it has one (87.5% of corpus chunks do).
 * @returns The document url, with a `#page=` fragment when a page is known; undefined for a source with
 *   no document of its own, whose caller keeps using the source's own url.
 */
export function documentUrl(sourceId: string, page?: number): string | undefined {
	// OWN properties only. A bare index reaches Object.prototype, so a sourceId of "constructor" or
	// "toString" returned a stringified function - a non-EMPTY string, which silently defeated every
	// caller's `?? card.url` https fallback and put that value into a citation href. The online path
	// narrows sourceId with `typeof === 'string'` alone, and the registry's own id pattern /^[a-z0-9_]+$/
	// matches those words, so neither gate upstream stops it.
	if (!Object.hasOwn(DOCUMENT_URLS, sourceId)) return undefined;
	const url = DOCUMENT_URLS[sourceId];
	if (url === undefined) return undefined;
	// The page is validated rather than trusted. This docstring used to assert that interpolation was safe
	// "because page is a number from the extraction pipeline" - but the runtime narrowing upstream is
	// `typeof === 'number'`, which admits NaN, Infinity, negatives and floats, and TS types are erased.
	// A bad page now yields the bare document url, exactly as a missing one does.
	if (!Number.isInteger(page) || (page as number) < 1) return url;
	return `${url}#page=${page}`;
}
