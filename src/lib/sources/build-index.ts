import type { SourceEntry } from '$lib/content-ops/sources-schema';
import type { Publisher, PublicSource, SourcesIndex, TapGuide } from './types';

// Map a registry `origin` string to a clean public publisher label. The origin encodes the agency plus
// an optional "(TAP curriculum)" marker (e.g. "VA (TAP curriculum)"), so we key off the prefix before
// the first " (". DoW folds to DoD (the statutory name); FRTIB surfaces as TSP (its public plan name).
function toPublisher(origin: string, sourceId: string): Publisher {
	const prefix = (origin.split(' (')[0] ?? '').trim();
	switch (prefix) {
		case 'VA':
			return 'VA';
		case 'DOL':
			return 'DOL';
		case 'DoW':
		case 'DoD':
			return 'DoD';
		case 'FRTIB':
			return 'TSP';
		default:
			// A new agency prefix must be mapped deliberately, not silently shown raw on a public page.
			throw Object.assign(new Error('E_SOURCES_INDEX_UNMAPPED_PUBLISHER'), { sourceId });
	}
}

/**
 * Project the parsed source registry into the public About index.
 *
 * Splits html sources into agency pages and pdf sources into TAP curriculum guides (the two coincide
 * with the registry's own agency-vs-TAP division). Only public fields are carried across; the legal
 * record's internal fields never enter the result. Input order is preserved within each section.
 *
 * @param entries Already-parsed, schema-valid source entries (YAML parsing stays in content-ops).
 * @returns The agency pages, the single shared TAP library url, and the TAP guide list.
 * @throws Error `E_SOURCES_INDEX_UNMAPPED_PUBLISHER` if an origin prefix has no publisher mapping.
 * @throws Error `E_SOURCES_INDEX_TAP_MULTI_URL` if the TAP guides do not all share one url.
 */
export function buildSourcesIndex(entries: SourceEntry[]): SourcesIndex {
	const agency: PublicSource[] = [];
	const tapGuides: TapGuide[] = [];
	const tapUrls = new Set<string>();

	for (const e of entries) {
		const publisher = toPublisher(e.origin, e.source_id);
		if (e.content_type === 'pdf') {
			tapGuides.push({ title: e.title, publisher });
			tapUrls.add(e.url);
		} else {
			agency.push({ title: e.title, url: e.url, publisher });
		}
	}

	// The whole point of the TAP section is that every guide lives at ONE shared library url; more than
	// one means the registry changed shape and the single-link presentation would silently mislead.
	if (tapUrls.size > 1) {
		throw new Error('E_SOURCES_INDEX_TAP_MULTI_URL');
	}
	const tapLibraryUrl = tapUrls.values().next().value ?? '';

	return { agency, tapLibraryUrl, tapGuides };
}
