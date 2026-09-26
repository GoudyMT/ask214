import { describe, it, expect } from 'vitest';
import type { SourceEntry } from '$lib/content-ops/sources-schema';
import { buildLocalDocuments } from './build-local-documents';

// Same shape as build-document-urls.test.ts: a full SourceEntry with sane defaults, overridden per case. The
// defaults are a served, redistribution-cleared pdf, as every served registry entry is.
function entry(over: Partial<SourceEntry>): SourceEntry {
	return {
		source_id: 'x',
		title: 'X',
		url: 'https://www.tapevents.mil/resources/documents',
		origin: 'VA',
		copyright_status: 'us_government_work_public_domain',
		legal_tier: 'confident_pd',
		content_type: 'pdf',
		license_notes: 'INTERNAL: 17 USC 105',
		served: true,
		redistribution_cleared: true,
		access: 'open',
		scrape_method: 'direct_url',
		update_check: 'monthly',
		corpus_version_first_included: '1.0',
		...over
	};
}

// The registry leaves an optional flag out rather than writing it false, so "absent" is its own case.
function without(e: SourceEntry, key: 'served' | 'redistribution_cleared'): SourceEntry {
	const copy = { ...e };
	delete copy[key];
	return copy;
}

// The real namer hashes the capture identity; a stub keeps these tests about the PROJECTION.
const nameFor = (sourceId: string, contentHash: string) =>
	`${sourceId}.${contentHash.slice(0, 4)}.pdf`;

describe('buildLocalDocuments', () => {
	it('maps a pdf source id to the path its served copy is published at', () => {
		const entries = [entry({ source_id: 'tap_dc', content_hash: 'abcdef0123' })];
		expect(buildLocalDocuments(entries, nameFor)).toEqual({ tap_dc: '/docs/tap_dc.abcd.pdf' });
	});

	// Html sources are never re-hosted, so they have no served copy and must not appear here. A path for
	// one would give a page that already has a url a second name the two could drift apart under.
	it('omits html sources, which are never re-hosted', () => {
		const entries = [
			entry({ source_id: 'tap_dc', content_hash: 'abcdef0123' }),
			entry({ source_id: 'va_page', content_type: 'html', content_hash: 'ffffffff' })
		];
		expect(buildLocalDocuments(entries, nameFor)).toEqual({ tap_dc: '/docs/tap_dc.abcd.pdf' });
	});

	// Re-hosting is a legal act the registry records per document. A pdf the registry does not mark served
	// has no published copy, and a path for it would put a document on the page that nobody cleared.
	it('omits a pdf whose served is not true', () => {
		const entries = [
			entry({ source_id: 'tap_dc', content_hash: 'abcdef0123' }),
			entry({ source_id: 'tap_off', content_hash: 'bbbbbbbb', served: false }),
			without(entry({ source_id: 'tap_unset', content_hash: 'cccccccc' }), 'served')
		];
		expect(buildLocalDocuments(entries, nameFor)).toEqual({ tap_dc: '/docs/tap_dc.abcd.pdf' });
	});

	// Served and cleared are separate records; the schema requires both, and this gate must not trust that
	// the schema ran.
	it('omits a pdf that is not redistribution-cleared', () => {
		const entries = [
			entry({ source_id: 'tap_dc', content_hash: 'abcdef0123' }),
			entry({
				source_id: 'tap_uncleared',
				content_hash: 'bbbbbbbb',
				redistribution_cleared: false
			}),
			without(entry({ source_id: 'tap_unset', content_hash: 'cccccccc' }), 'redistribution_cleared')
		];
		expect(buildLocalDocuments(entries, nameFor)).toEqual({ tap_dc: '/docs/tap_dc.abcd.pdf' });
	});

	// A hole here is a dead citation: the reader would resolve nothing for a document that exists.
	it('fails closed when a pdf source carries no capture hash', () => {
		const entries = [entry({ source_id: 'tap_dc' })];
		expect(() => buildLocalDocuments(entries, nameFor)).toThrow('E_LOCAL_DOCUMENTS_MISSING_HASH');
	});

	it('fails closed on an empty capture hash, not just a missing one', () => {
		const entries = [entry({ source_id: 'tap_dc', content_hash: '' })];
		expect(() => buildLocalDocuments(entries, nameFor)).toThrow('E_LOCAL_DOCUMENTS_MISSING_HASH');
	});

	it('returns an empty map for a registry with no pdf sources', () => {
		expect(buildLocalDocuments([entry({ content_type: 'html' })], nameFor)).toEqual({});
	});
});
