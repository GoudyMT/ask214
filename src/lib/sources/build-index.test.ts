import { describe, it, expect } from 'vitest';
import type { SourceEntry } from '$lib/content-ops/sources-schema';
import { buildSourcesIndex } from './build-index';

// A full SourceEntry with sane defaults; override per case. The internal fields below (content_hash,
// captured_path, reviewed_by, terms_notes, license_notes) are the ones the public index MUST NOT leak.
function entry(over: Partial<SourceEntry>): SourceEntry {
	return {
		source_id: 'x',
		title: 'X',
		url: 'https://example.gov/x',
		origin: 'VA',
		copyright_status: 'us_government_work_public_domain',
		legal_tier: 'confident_pd',
		content_type: 'html',
		license_notes: 'INTERNAL: 17 USC 105',
		access: 'open',
		scrape_method: 'direct_url',
		update_check: 'monthly',
		corpus_version_first_included: '1.0',
		reviewed_by: 'max',
		reviewed_date: '2026-06-21',
		terms_reviewed_date: '2026-06-21',
		terms_notes: 'INTERNAL terms',
		content_hash: 'deadbeefdeadbeef',
		captured_path: 'content-ops/captures/deadbeefdeadbeef.html',
		...over
	};
}

const TAP_URL = 'https://www.tapevents.mil/resources/documents';

describe('buildSourcesIndex', () => {
	it('splits agency (html) from TAP (pdf)', () => {
		const idx = buildSourcesIndex([
			entry({ source_id: 'a', title: 'VA page', content_type: 'html', origin: 'VA' }),
			entry({
				source_id: 'b',
				title: 'TAP guide',
				content_type: 'pdf',
				origin: 'VA (TAP curriculum)',
				url: TAP_URL
			})
		]);
		expect(idx.agency).toHaveLength(1);
		expect(idx.tapGuides).toHaveLength(1);
		expect(idx.agency[0]?.title).toBe('VA page');
		expect(idx.tapGuides[0]?.title).toBe('TAP guide');
	});

	it('normalizes the publisher label (DoW -> DoD, FRTIB -> TSP, DOL/VA passthrough)', () => {
		const idx = buildSourcesIndex([
			entry({ source_id: 'va', origin: 'VA' }),
			entry({ source_id: 'mos', origin: 'DoW (Military OneSource)' }),
			entry({ source_id: 'dol', origin: 'DOL (VETS)' }),
			entry({ source_id: 'tsp', origin: 'FRTIB (Thrift Savings Plan)' })
		]);
		expect(idx.agency.map((r) => r.publisher)).toEqual(['VA', 'DoD', 'DOL', 'TSP']);
	});

	it('normalizes DoW authors inside the TAP section too', () => {
		const idx = buildSourcesIndex([
			entry({ source_id: 't1', content_type: 'pdf', origin: 'DoW (TAP curriculum)', url: TAP_URL }),
			entry({ source_id: 't2', content_type: 'pdf', origin: 'VA (TAP curriculum)', url: TAP_URL })
		]);
		expect(idx.tapGuides.map((g) => g.publisher)).toEqual(['DoD', 'VA']);
	});

	it('preserves input order in each section', () => {
		const idx = buildSourcesIndex([
			entry({ source_id: 'a', title: 'First', content_type: 'html' }),
			entry({ source_id: 'b', title: 'Second', content_type: 'html' }),
			entry({ source_id: 'c', title: 'Third', content_type: 'html' })
		]);
		expect(idx.agency.map((r) => r.title)).toEqual(['First', 'Second', 'Third']);
	});

	it('exposes the single shared TAP library url', () => {
		const idx = buildSourcesIndex([
			entry({ source_id: 't1', content_type: 'pdf', origin: 'VA (TAP curriculum)', url: TAP_URL }),
			entry({ source_id: 't2', content_type: 'pdf', origin: 'VA (TAP curriculum)', url: TAP_URL })
		]);
		expect(idx.tapLibraryUrl).toBe(TAP_URL);
	});

	it('projects PUBLIC fields only - no internal legal-record fields leak', () => {
		const idx = buildSourcesIndex([
			entry({ source_id: 'a', content_type: 'html' }),
			entry({ source_id: 'b', content_type: 'pdf', origin: 'VA (TAP curriculum)', url: TAP_URL })
		]);
		expect(Object.keys(idx.agency[0]!).sort()).toEqual(['publisher', 'title', 'url']);
		expect(Object.keys(idx.tapGuides[0]!).sort()).toEqual(['publisher', 'title']);
		expect(JSON.stringify(idx)).not.toContain('deadbeef');
		expect(JSON.stringify(idx)).not.toContain('INTERNAL');
		expect(JSON.stringify(idx)).not.toContain('captures/');
	});

	it('throws on an unmapped publisher prefix', () => {
		expect(() => buildSourcesIndex([entry({ source_id: 'z', origin: 'NASA (space)' })])).toThrow(
			'E_SOURCES_INDEX_UNMAPPED_PUBLISHER'
		);
	});

	it('throws when the TAP guides do not share exactly one url', () => {
		expect(() =>
			buildSourcesIndex([
				entry({
					source_id: 't1',
					content_type: 'pdf',
					origin: 'VA (TAP curriculum)',
					url: TAP_URL
				}),
				entry({
					source_id: 't2',
					content_type: 'pdf',
					origin: 'VA (TAP curriculum)',
					url: 'https://other.mil/docs'
				})
			])
		).toThrow('E_SOURCES_INDEX_TAP_MULTI_URL');
	});

	it('handles a registry with no TAP guides (empty library url + guides)', () => {
		const idx = buildSourcesIndex([entry({ source_id: 'a', content_type: 'html' })]);
		expect(idx.tapGuides).toEqual([]);
		expect(idx.tapLibraryUrl).toBe('');
	});
});
