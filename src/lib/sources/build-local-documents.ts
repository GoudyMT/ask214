import type { SourceEntry } from '$lib/content-ops/sources-schema';

/** Source id -> the app path its served copy is published at. Served pdf sources only; see buildLocalDocuments. */
export type LocalDocuments = Record<string, string>;

/** The namespace served documents are published under; the device keeps one only when the user saves it. */
const DOCS_PREFIX = '/docs/';

/**
 * Whether the registry records a source as re-hosted by this app: a pdf marked both `served` and
 * `redistribution_cleared`.
 *
 * Re-hosting is a legal act the registry records per document, so this reads the record rather than the
 * content type alone. Both flags must be the boolean `true`; the schema requires `served` to imply
 * `redistribution_cleared`, and this does not rely on the schema having run. The publisher selects with this
 * same function, so the files it publishes and the paths the app resolves cannot disagree.
 *
 * @param e A source entry.
 * @returns True when the source has a served copy.
 */
export function isServedDocument(e: SourceEntry): boolean {
	return e.content_type === 'pdf' && e.served === true && e.redistribution_cleared === true;
}

/**
 * Project the source registry into a source-id -> served-document-path lookup.
 *
 * This is the app's only route from a citation to the document itself. It is deliberately separate from
 * the document-url map, which points at the government's copy on its own site: that url is what the
 * reader links OUT to, this path is what the reader RENDERS. A source has both, and conflating them would
 * mean either rendering a cross-origin fetch or linking the user to our derived copy as though it were
 * the official one.
 *
 * HTML sources are omitted because they are never re-hosted - their url is already the document. A pdf the
 * registry does not record as served and redistribution-cleared is omitted too (see isServedDocument).
 *
 * The filename is computed by the caller rather than here. Publishing and this projection must agree
 * EXACTLY on the name or a citation resolves to a 404, so there is one implementation of it, in the same
 * module the publisher uses, injected here.
 *
 * @param entries Already-parsed, schema-valid source entries (YAML parsing stays in content-ops).
 * @param nameFor Produces a published filename from a source id and its capture hash.
 * @returns A map from source id to served path, containing every served pdf source and nothing else.
 * @throws Error `E_LOCAL_DOCUMENTS_MISSING_HASH` if a served pdf entry carries no capture hash. The hash is
 *   what makes the name change when the document changes, so a hole here would either drop a document from
 *   the app or pin it to a name that can never be invalidated.
 */
export function buildLocalDocuments(
	entries: SourceEntry[],
	nameFor: (sourceId: string, contentHash: string) => string
): LocalDocuments {
	const documents: LocalDocuments = {};
	for (const e of entries) {
		if (!isServedDocument(e)) continue;
		if (typeof e.content_hash !== 'string' || e.content_hash === '') {
			throw Object.assign(new Error('E_LOCAL_DOCUMENTS_MISSING_HASH'), { sourceId: e.source_id });
		}
		documents[e.source_id] = `${DOCS_PREFIX}${nameFor(e.source_id, e.content_hash)}`;
	}
	return documents;
}
