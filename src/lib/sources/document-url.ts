import { DOCUMENT_URLS } from './document-urls.data';

/**
 * The url of the document a chunk was taken from, anchored to the cited page.
 *
 * PDF sources all share one TAP library url in the registry, so a citation built from `chunk.url` lands
 * the reader on a directory listing 21 documents rather than on the one they asked about. This resolves
 * the document itself and points at the page the passage is on.
 *
 * The page fragment is safe to build by interpolation: `page` is a number from the extraction pipeline,
 * and the base is a registry value the schema has already gated as https.
 *
 * @param sourceId The chunk's source id.
 * @param page The chunk's 1-based physical page, when it has one (87.5% of corpus chunks do).
 * @returns The document url, with a `#page=` fragment when a page is known; undefined for a source with
 *   no document of its own, whose caller keeps using the source's own url.
 */
export function documentUrl(sourceId: string, page?: number): string | undefined {
	const url = DOCUMENT_URLS[sourceId];
	if (url === undefined) return undefined;
	return page === undefined ? url : `${url}#page=${page}`;
}
