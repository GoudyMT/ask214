import { describe, expect, it } from 'vitest';
import { afterStartupFailure } from './context';

describe('afterStartupFailure', () => {
	// Another tab on a newer release took the database over and closed this connection, so the start-up then failed on
	// its next read. The takeover names the real cause and offers the reload onto the newer release; it must stay.
	it('keeps the updated-in-another-tab screen', () => {
		expect(afterStartupFailure('stale', 'error')).toBe('stale');
		expect(afterStartupFailure('stale', 'damaged')).toBe('stale');
	});

	it('moves a start-up still loading to the failure', () => {
		expect(afterStartupFailure('loading', 'error')).toBe('error');
		expect(afterStartupFailure('loading', 'damaged')).toBe('damaged');
	});
});
