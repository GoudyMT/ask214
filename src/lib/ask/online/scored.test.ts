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
				url: 'https://tapevents.mil/moc',
				title: 'MOC Crosswalk'
			}
		]);
	});
});
