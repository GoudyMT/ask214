import { documentStates, type DocumentState } from './document-states';
import { LOCAL_DOCUMENT_INFO } from './local-document-info.data';
import { LOCAL_DOCUMENT_BYTES, LOCAL_DOCUMENTS } from './local-documents.data';
import type { TapGuide } from './types';

/** One served document as the Documents area shows and acts on it. */
export type LibraryDocument = TapGuide & {
	sourceId: string;
	path: string;
	bytes: number;
	pages: number;
	state: DocumentState;
	stale: string[];
};

/**
 * Every served document with what this device holds of it, in the generated map's order.
 *
 * @param cachedPaths The `/docs/` pathnames held in the asset cache.
 * @returns One entry per served document.
 */
export function documentLibrary(cachedPaths: readonly string[]): LibraryDocument[] {
	const states = documentStates(cachedPaths, LOCAL_DOCUMENTS);
	const library: LibraryDocument[] = [];
	for (const [sourceId, path] of Object.entries(LOCAL_DOCUMENTS)) {
		const info = localDocumentInfo(sourceId);
		const bytes = LOCAL_DOCUMENT_BYTES[sourceId];
		const held = states[sourceId];
		// The three generated maps are drift-gated against each other, so a gap here is unreachable.
		if (info === undefined || bytes === undefined || held === undefined) continue;
		library.push({ sourceId, path, bytes, ...info, ...held });
	}
	return library;
}

/**
 * A served document's title, publisher and page count, for the Documents area's list.
 *
 * @param sourceId The document's source id.
 * @returns The description, or undefined for an html source or an unknown id.
 */
export function localDocumentInfo(sourceId: string): (TapGuide & { pages: number }) | undefined {
	// Own properties only: a bare index reaches Object.prototype, so "constructor" would return a function.
	if (!Object.hasOwn(LOCAL_DOCUMENT_INFO, sourceId)) return undefined;
	return LOCAL_DOCUMENT_INFO[sourceId];
}
