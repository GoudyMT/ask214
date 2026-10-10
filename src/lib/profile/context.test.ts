import { describe, expect, it } from 'vitest';
import { afterStartupFailure, afterStartupResult } from './context';

describe('afterStartupResult', () => {
	// A start-up that outlasted its timeout left `error` up; its later result is the recovery the user chose.
	it('takes the result over a start-up still loading or timed out', () => {
		expect(afterStartupResult('loading', 'ready')).toBe('ready');
		expect(afterStartupResult('error', 'ready')).toBe('ready');
		expect(afterStartupResult('error', 'damaged')).toBe('damaged');
	});

	// A takeover names a cause no result can undo: the tab is on an old bundle, or cannot run at all.
	it('never replaces a takeover', () => {
		expect(afterStartupResult('stale', 'ready')).toBe('stale');
		expect(afterStartupResult('stale', 'damaged')).toBe('stale');
		expect(afterStartupResult('unsupported', 'ready')).toBe('unsupported');
	});
});

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
