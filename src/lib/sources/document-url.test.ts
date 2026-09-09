import { describe, it, expect } from 'vitest';
import { documentUrl } from './document-url';

// Real registry ids, not invented ones: a fixture that does not look like the shipped data can pass while
// the shipped data is broken.
const VETCEN = 'https://www.tapevents.mil/Assets/ResourceContent/TAP/MLC-VETCEN.pdf';

describe('documentUrl', () => {
	it('returns the document url for a pdf source', () => {
		expect(documentUrl('tap_vet_centers')).toBe(VETCEN);
	});

	// Verified against the real PDFs this session: the corpus `page` is the physical page index (169/172
	// chunks anchor exactly across 12 documents), which is what the #page fragment addresses.
	it('anchors to the cited page so the document opens where the passage is', () => {
		expect(documentUrl('tap_vet_centers', 2)).toBe(`${VETCEN}#page=2`);
	});

	// 12.5% of corpus chunks carry no page. They still reach the right document, just not a page.
	it('returns the bare document url when the chunk has no page', () => {
		expect(documentUrl('tap_vet_centers', undefined)).toBe(VETCEN);
	});

	// An html agency page is not in the map; its own url is already the document, so the caller keeps
	// using that rather than being handed a second link.
	it('returns undefined for an html source', () => {
		expect(documentUrl('va_intent_to_file')).toBeUndefined();
	});

	it('returns undefined for an unknown source id', () => {
		expect(documentUrl('not_a_source')).toBeUndefined();
	});
});
