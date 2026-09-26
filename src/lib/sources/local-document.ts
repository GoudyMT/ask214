import { LOCAL_DOCUMENT_BYTES, LOCAL_DOCUMENTS } from './local-documents.data';

/**
 * The app path of the served copy of a source's document, when one exists.
 *
 * Only PDF sources have one; the 25 HTML sources are never re-hosted, so they resolve to undefined and
 * their callers keep the text reader plus a link to the live page.
 *
 * @param sourceId The chunk's source id.
 * @returns The served path, or undefined for an html source or an unknown id.
 */
export function localDocumentPath(sourceId: string): string | undefined {
	// OWN properties only. A bare index reaches Object.prototype, so a sourceId of "constructor" or
	// "toString" returns a stringified function - a non-EMPTY string, which silently defeats a caller's
	// `?? fallback` and puts that value where a document path was expected. The sibling document-url
	// lookup shipped exactly that bug, and the registry's own id pattern matches those words.
	if (!Object.hasOwn(LOCAL_DOCUMENTS, sourceId)) return undefined;
	return LOCAL_DOCUMENTS[sourceId];
}

/**
 * The byte size of a source's served document, so the reader can state it before the first download.
 *
 * @param sourceId The chunk's source id.
 * @returns The size in bytes, or undefined for an html source or an unknown id.
 */
export function localDocumentSize(sourceId: string): number | undefined {
	// Own properties only, for the reason given above.
	if (!Object.hasOwn(LOCAL_DOCUMENT_BYTES, sourceId)) return undefined;
	return LOCAL_DOCUMENT_BYTES[sourceId];
}
