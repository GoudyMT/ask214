import type { SourceEntry } from '$lib/content-ops/sources-schema';

/** Source id -> the url of that source's own document. PDF sources only; see buildDocumentUrls. */
export type DocumentUrls = Record<string, string>;

/**
 * Project the source registry into a source-id -> document-url lookup.
 *
 * Deliberately NOT part of the About index. That index is shaped for a public page and states that it
 * carries only fields safe to show there; it has no source ids, and its TAP guides share one library url
 * by design (buildSourcesIndex throws if they ever stop sharing it). This map answers a different
 * question - "where is this exact document?" - and needs the internal id to answer it, so it is built and
 * gated separately rather than by widening a well-bounded public type.
 *
 * HTML sources are omitted: their `url` is already the document, and the cards link to it directly.
 * Listing them here would make one page reachable under two names that could drift apart.
 *
 * @param entries Already-parsed, schema-valid source entries (YAML parsing stays in content-ops).
 * @returns A map from source id to document url, containing every pdf source and nothing else.
 * @throws Error `E_DOCUMENT_URLS_MISSING` if a pdf entry carries no document_url. The schema already
 *   requires it, so reaching this means the registry was edited without revalidating - and a map with a
 *   silent hole in it would put back the dead-end citation this exists to prevent.
 */
export function buildDocumentUrls(entries: SourceEntry[]): DocumentUrls {
	const urls: DocumentUrls = {};
	for (const e of entries) {
		if (e.content_type !== 'pdf') continue;
		if (typeof e.document_url !== 'string' || e.document_url === '') {
			throw Object.assign(new Error('E_DOCUMENT_URLS_MISSING'), { sourceId: e.source_id });
		}
		urls[e.source_id] = e.document_url;
	}
	return urls;
}
