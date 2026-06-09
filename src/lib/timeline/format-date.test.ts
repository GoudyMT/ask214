import { describe, it, expect } from 'vitest';
import { formatTimelineDate } from './format-date';

// formatTimelineDate turns an engine ISO date (YYYY-MM-DD, UTC-anchored from eaosOffsetDate)
// into the human "Mon D, YYYY" form the timeline cards + the route subline display (locked
// Session 19: mockup uses human dates; raw ISO is for storage/anchoring only).

describe('formatTimelineDate', () => {
	it('formats an ISO date as "Mon D, YYYY"', () => {
		expect(formatTimelineDate('2027-03-16')).toBe('Mar 16, 2027');
		expect(formatTimelineDate('2026-04-15')).toBe('Apr 15, 2026');
	});

	it('renders the day with no leading zero', () => {
		expect(formatTimelineDate('2027-01-05')).toBe('Jan 5, 2027');
	});

	it('is UTC-anchored - boundary dates never shift by the runtime timezone', () => {
		expect(formatTimelineDate('2027-01-01')).toBe('Jan 1, 2027');
		expect(formatTimelineDate('2027-12-31')).toBe('Dec 31, 2027');
	});
});
