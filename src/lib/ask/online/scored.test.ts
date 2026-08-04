import { describe, it, expect } from 'vitest';
import { narrowScored, toRetrievedChunks } from './scored';

const wireHit = (over: Record<string, unknown> = {}) => ({
	score: 0.82,
	chunk: {
		id: 'tap_moc_crosswalk',
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
		expect(out[0]!.chunk.id).toBe('tap_moc_crosswalk');
		expect(out[0]!.chunk.section).toBe('Ch. 2');
	});

	it('drops a hit missing a load-bearing string field (defensive - never trust a bad hit)', () => {
		expect(narrowScored([wireHit({ url: undefined })])).toHaveLength(0);
		expect(narrowScored([{ score: 0.5, chunk: null }])).toHaveLength(0);
		expect(narrowScored([{ chunk: wireHit().chunk }])).toHaveLength(0); // no numeric score
		expect(narrowScored(['nonsense', 42])).toHaveLength(0);
	});
});

describe('toRetrievedChunks', () => {
	it('projects each hit to the RetrievedChunk synthesize reads (title = sourceTitle)', () => {
		const chunks = toRetrievedChunks(narrowScored([wireHit()]));
		expect(chunks).toEqual([
			{
				id: 'tap_moc_crosswalk',
				text: 'Use the MOC crosswalk.',
				url: 'https://tapevents.mil/moc',
				title: 'MOC Crosswalk'
			}
		]);
	});
});
