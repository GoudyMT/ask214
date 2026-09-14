import { describe, it, expect } from 'vitest';
import type { SourceEntry } from '$lib/content-ops/sources-schema';
import { buildDocumentUrls } from './build-document-urls';

// Same shape as build-index.test.ts: a full SourceEntry with sane defaults, overridden per case.
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
		access: 'open',
		scrape_method: 'direct_url',
		update_check: 'monthly',
		corpus_version_first_included: '1.0',
		...over
	};
}

const DOC = 'https://www.tapevents.mil/Assets/ResourceContent/TAP/MLC-DC.pdf';

describe('buildDocumentUrls', () => {
	it('maps a pdf source id to its own document url', () => {
		expect(buildDocumentUrls([entry({ source_id: 'tap_dc', document_url: DOC })])).toEqual({
			tap_dc: DOC
		});
	});

	// An html source's `url` is already the document, and the result cards link to it directly. Putting it
	// in this map would make the same page reachable by two names and invite the two to drift apart.
	it('omits html sources, whose url is already the document', () => {
		expect(
			buildDocumentUrls([
				entry({ source_id: 'va_page', content_type: 'html', url: 'https://va.gov/x' })
			])
		).toEqual({});
	});

	// The schema requires document_url on every pdf, so a missing one here means the registry was edited
	// without revalidating. Failing loudly beats generating a map with a silent hole in it.
	it('throws when a pdf source has no document_url', () => {
		expect(() => buildDocumentUrls([entry({ source_id: 'tap_gap' })])).toThrow(
			'E_DOCUMENT_URLS_MISSING'
		);
	});

	it('keeps every distinct source, and does not collapse guides that share a library url', () => {
		const map = buildDocumentUrls([
			entry({
				source_id: 'a',
				document_url: 'https://www.tapevents.mil/Assets/ResourceContent/TAP/A.pdf'
			}),
			entry({
				source_id: 'b',
				document_url: 'https://www.tapevents.mil/Assets/ResourceContent/TAP/B.pdf'
			})
		]);
		expect(map).toEqual({
			a: 'https://www.tapevents.mil/Assets/ResourceContent/TAP/A.pdf',
			b: 'https://www.tapevents.mil/Assets/ResourceContent/TAP/B.pdf'
		});
	});
});
