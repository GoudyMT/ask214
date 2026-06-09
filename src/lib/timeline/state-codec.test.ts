import { describe, it, expect } from 'vitest';
import { encodeTimelineState, decodeTimelineState } from './state-codec';
import type { TimelineState } from './types';

describe('timeline-state codec', () => {
	it('round-trips state with schemaVersion inside', () => {
		const state: TimelineState = {
			schemaVersion: 1,
			tasks: { 'dd214-review': { status: 'done', notes: 'saved copies' } }
		};
		const back = decodeTimelineState(encodeTimelineState(state));
		expect(back).toEqual(state);
	});

	it('rejects non-JSON bytes', () => {
		expect(() => decodeTimelineState(new TextEncoder().encode('not json'))).toThrow();
	});

	it('rejects an unsupported schemaVersion', () => {
		expect(() =>
			decodeTimelineState(new TextEncoder().encode('{"schemaVersion":9,"tasks":{}}'))
		).toThrow();
	});
});
