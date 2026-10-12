import { describe, it, expect } from 'vitest';
import { timelineAccess, panelAccess } from './store-access';

describe('timelineAccess', () => {
	it.each([
		[null, 'loading'],
		[{ ready: false, failed: false, locked: false }, 'loading'],
		[{ ready: false, failed: true, locked: false }, 'failed'],
		[{ ready: true, failed: true, locked: false }, 'failed'],
		[{ ready: false, failed: false, locked: true }, 'locked'],
		[{ ready: false, failed: true, locked: true }, 'failed'],
		[{ ready: true, failed: false, locked: false }, 'ready']
	] as const)('%o -> %s', (store, want) => {
		expect(timelineAccess(store)).toBe(want);
	});
});

// The page's own Unlock reads the timeline, then the calendar, and each stays locked until its own read lands: the
// page says loading for the whole read, not a lock or a failure that the read is about to clear.
describe('while the page opens the stores itself', () => {
	const LOCKED = { ready: false, failed: false, locked: true };
	const T = { ready: true, failed: false, locked: false };

	it('reads a locked timeline as loading, and as locked when it is not opening', () => {
		expect(timelineAccess(LOCKED, true)).toBe('loading');
		expect(timelineAccess(LOCKED, false)).toBe('locked');
		expect(timelineAccess(LOCKED)).toBe('locked');
	});

	it('reads locked stores as loading, and as they are when it is not opening', () => {
		expect(panelAccess(LOCKED, LOCKED, true)).toBe('loading');
		expect(panelAccess(LOCKED, LOCKED, false)).toBe('timeline-locked');
		expect(panelAccess(T, LOCKED, true)).toBe('loading');
		expect(panelAccess(T, LOCKED, false)).toBe('calendar-failed');
	});

	it('reads a failure as loading too, since the read that is running may clear it', () => {
		expect(timelineAccess({ ready: false, failed: true }, true)).toBe('loading');
		expect(panelAccess(T, { ready: false, failed: true }, true)).toBe('loading');
	});
});

describe('panelAccess', () => {
	const T = { ready: true, failed: false, locked: false };
	const C = { ready: true, failed: false };
	it.each([
		[T, C, 'ready'],
		[{ ...T, ready: false }, C, 'loading'],
		[T, { ready: false, failed: false }, 'loading'],
		[T, null, 'loading'],
		[T, { ready: false, failed: true }, 'calendar-failed'],
		[T, { ready: false, failed: false, locked: true }, 'calendar-failed'],
		[{ ...T, failed: true }, C, 'timeline-failed'],
		[{ ...T, failed: true }, { ready: false, failed: true }, 'timeline-failed'],
		[
			{ ready: false, failed: false, locked: true },
			{ ready: false, failed: true },
			'timeline-locked'
		],
		[{ ready: false, failed: false, locked: true }, C, 'timeline-locked'],
		[
			{ ready: false, failed: false, locked: true },
			{ ready: false, failed: false, locked: true },
			'timeline-locked'
		]
	] as const)('%o %o -> %s', (t, c, want) => {
		expect(panelAccess(t, c)).toBe(want);
	});
});
