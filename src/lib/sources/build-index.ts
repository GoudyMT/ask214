import type { SourceEntry } from '$lib/content-ops/sources-schema';
import { formatTimelineDate } from '../timeline/format-date';
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
 * @returns The agency pages, the single shared TAP library url, the TAP guide list, and the capture date range.
 * @throws Error `E_SOURCES_INDEX_UNMAPPED_PUBLISHER` if an origin prefix has no publisher mapping.
 * @throws Error `E_SOURCES_INDEX_NO_CAPTURE_DATE` if a source has no capture timestamp.
 * @throws Error `E_SOURCES_INDEX_TAP_MULTI_URL` if the TAP guides do not all share one url.
 */
export function buildSourcesIndex(entries: SourceEntry[]): SourcesIndex {
	const agency: PublicSource[] = [];
	const tapGuides: TapGuide[] = [];
	const tapUrls = new Set<string>();
	const capturedDays: string[] = [];

	for (const e of entries) {
		const publisher = toPublisher(e.origin, e.source_id);
		capturedDays.push(captureDay(e));
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

	// ISO days sort as text, so the first and last are the earliest and latest. They are formatted here, at
	// generation, so the About page ships the two strings and none of the date code.
	capturedDays.sort();
	const first = capturedDays[0];
	const last = capturedDays.at(-1);
	const captured =
		first === undefined || last === undefined
			? { from: '', to: '' }
			: { from: formatTimelineDate(first), to: formatTimelineDate(last) };

	return { agency, tapLibraryUrl, tapGuides, captured };
}

// The calendar day (UTC) a source was captured. A source with none would fall outside the range About states.
function captureDay(e: SourceEntry): string {
	const day = /^\d{4}-\d{2}-\d{2}T/.test(e.captured_at ?? '')
		? e.captured_at?.slice(0, 10)
		: undefined;
	if (day === undefined) {
		throw Object.assign(new Error('E_SOURCES_INDEX_NO_CAPTURE_DATE'), { sourceId: e.source_id });
	}
	return day;
}
