import { describe, it, expect } from 'vitest';
import { narrowScored, toRetrievedChunks } from './scored';

const wireHit = (over: Record<string, unknown> = {}) => ({
	score: 0.82,
	chunk: {
		// A real chunk-id shape. This projection feeds synthesize, whose citation parser could not read a
		// colon for the life of the feature - a colon-free fixture here is what let that pass review.
		id: 'tap_moc_crosswalk:0fb72e844a79',
		text: 'Use the MOC crosswalk.',
		sourceId: 'tap_moc',
		sourceTitle: 'MOC Crosswalk',
		url: 'https://tapevents.mil/moc',
		tags: [],
		section: 'Ch. 2',
		...over
	}
});

describe('narrowScored', () => {
	it('keeps a well-formed hit as a RetrievalResult (chunk + score)', () => {
		const out = narrowScored([wireHit()]);
		expect(out).toHaveLength(1);
		expect(out[0]!.score).toBe(0.82);
		expect(out[0]!.chunk.id).toBe('tap_moc_crosswalk:0fb72e844a79');
		expect(out[0]!.chunk.section).toBe('Ch. 2');
	});

	it('drops a hit missing a load-bearing string field (defensive - never trust a bad hit)', () => {
		expect(narrowScored([wireHit({ url: undefined })])).toHaveLength(0);
		expect(narrowScored([{ score: 0.5, chunk: null }])).toHaveLength(0);
		expect(narrowScored([{ chunk: wireHit().chunk }])).toHaveLength(0); // no numeric score
		expect(narrowScored(['nonsense', 42])).toHaveLength(0);
	});

	// A scheme check is not the boundary this project has. It ships public US-Government work only, and these
	// urls become citation hrefs on a surface whose audience is targeted by benefits scams - so a server
	// response, or anything that can influence one, must not be able to put an arbitrary https host in front
	// of a veteran. The registry side already enforces the hostname; this is the runtime side of the same
	// rule. Note `https://tapevents.mil.evil.example` passes every scheme check ever written: the ".mil" is
	// a label, not the host.
	it('drops a hit whose url is https but not a government host', () => {
		expect(narrowScored([wireHit({ url: 'https://example.com/benefits' })])).toHaveLength(0);
		expect(narrowScored([wireHit({ url: 'https://tapevents.mil.evil.example/x' })])).toHaveLength(
			0
		);
		expect(narrowScored([wireHit({ url: 'https://va.gov.attacker.io/claim' })])).toHaveLength(0);
		expect(narrowScored([wireHit({ url: 'https://www.va.gov/health' })])).toHaveLength(1);
		expect(narrowScored([wireHit({ url: 'https://tapevents.mil/moc' })])).toHaveLength(1);
	});

	it('drops a hit whose url is not https (defense against a javascript:/http: card href)', () => {
		expect(narrowScored([wireHit({ url: 'javascript:alert(1)' })])).toHaveLength(0);
		expect(narrowScored([wireHit({ url: 'http://insecure.gov' })])).toHaveLength(0);
		expect(narrowScored([wireHit({ url: 'https://ok.gov' })])).toHaveLength(1);
	});
});

describe('toRetrievedChunks', () => {
	it('projects each hit to the RetrievedChunk synthesize reads (title = sourceTitle)', () => {
		const chunks = toRetrievedChunks(narrowScored([wireHit()]));
		expect(chunks).toEqual([
			{
				id: 'tap_moc_crosswalk:0fb72e844a79',
				text: 'Use the MOC crosswalk.',
				sourceId: 'tap_moc',
				url: 'https://tapevents.mil/moc',
				title: 'MOC Crosswalk'
			}
		]);
	});

	// The page is what anchors a citation deep link to the right page of the real document; 87.5% of
	// shipped chunks carry one, so dropping it here would silently flatten most citations to the document's
	// first page.
	it('carries the page through when the hit has one', () => {
		const chunks = toRetrievedChunks(narrowScored([wireHit({ page: 7 })]));
		expect(chunks[0]!.page).toBe(7);
	});

	// Absent, not undefined: an `undefined` key would violate exactOptionalPropertyTypes and read as a
	// known-missing page rather than a chunk that never had one.
	it('omits page entirely when the hit has none', () => {
		const chunks = toRetrievedChunks(narrowScored([wireHit()]));
		expect(chunks[0]).not.toHaveProperty('page');
	});
});
