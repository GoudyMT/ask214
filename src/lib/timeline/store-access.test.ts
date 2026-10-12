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
