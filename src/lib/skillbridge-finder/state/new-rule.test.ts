import { describe, it, expect } from 'vitest';
import { cleanListing } from '../fixtures/clean';
import { isNew, isRollback, nextLastSeen, pruneSeen, type NewContext } from './new-rule';

const RECENT = ['2026-10-14', '2026-10-21'];
const ctx = (extra: Partial<NewContext> = {}): NewContext => ({
	recentPullDates: RECENT,
	baselineDate: '2026-09-30',
	openedIds: new Set(),
	keptIds: new Set(),
	...extra
});

describe('isNew', () => {
	it('marks a listing first seen in a recent update and created shortly before as New', () => {
		expect(isNew(cleanListing({ fl: '2026-10-21', dc: '2026-10-01' }), ctx())).toBe(true);
	});

	// A listing created long before it was first seen is old stock that only just appeared; "New" would mislead.
	it('allows 30 days between creation and first sight, not 31', () => {
		expect(isNew(cleanListing({ fl: '2026-10-14', dc: '2026-09-14' }), ctx())).toBe(true);
		expect(isNew(cleanListing({ fl: '2026-10-14', dc: '2026-09-13' }), ctx())).toBe(false);
	});

	it('counts the days across a month and a leap day by calendar, not by clock', () => {
		const leap = ctx({ recentPullDates: ['2028-03-01'], baselineDate: '2027-01-01' });
		expect(isNew(cleanListing({ fl: '2028-03-01', dc: '2028-01-31' }), leap)).toBe(true);
		expect(isNew(cleanListing({ fl: '2028-03-01', dc: '2028-01-30' }), leap)).toBe(false);
	});

	it('treats a creation date after first sight as zero days', () => {
		expect(isNew(cleanListing({ fl: '2026-10-14', dc: '2026-10-15' }), ctx())).toBe(true);
	});

	// New lasts two weekly updates on the data's own clock: the older of the two still counts, the one before not.
	it('lasts through the older of the last two updates and not past it', () => {
		expect(isNew(cleanListing({ fl: '2026-10-14', dc: '2026-10-10' }), ctx())).toBe(true);
		expect(isNew(cleanListing({ fl: '2026-10-07', dc: '2026-10-01' }), ctx())).toBe(false);
	});

	it('is not New when the update names no recent weeks', () => {
		expect(
			isNew(cleanListing({ fl: '2026-10-21', dc: '2026-10-20' }), ctx({ recentPullDates: [] }))
		).toBe(false);
	});

	// The first full pull put every listing in front of people at once; none of them is new.
	it('is never New when first seen on the baseline pull, even when that pull is recent', () => {
		const onBaseline = ctx({ baselineDate: '2026-10-14' });
		expect(isNew(cleanListing({ fl: '2026-10-14', dc: '2026-10-10' }), onBaseline)).toBe(false);
		expect(isNew(cleanListing({ fl: '2026-10-21', dc: '2026-10-10' }), onBaseline)).toBe(true);
	});

	it('is not New once opened', () => {
		const listing = cleanListing({ i: 7, fl: '2026-10-21', dc: '2026-10-10' });
		expect(isNew(listing, ctx({ openedIds: new Set([7]) }))).toBe(false);
		expect(isNew(listing, ctx({ openedIds: new Set([8]) }))).toBe(true);
	});

	// A saved or compared program (including one restored from a backup) is already one the person chose.
	it('is not New when saved or compared', () => {
		const listing = cleanListing({ i: 7, fl: '2026-10-21', dc: '2026-10-10' });
		expect(isNew(listing, ctx({ keptIds: new Set([7]) }))).toBe(false);
	});

	it('is not New on a date it cannot read', () => {
		expect(isNew(cleanListing({ fl: '2026-10-21', dc: 'soon' }), ctx())).toBe(false);
	});
});

describe('pruneSeen', () => {
	it('keeps only ids first listed in a recent update', () => {
		const firstListed = new Map([
			[1, '2026-10-21'],
			[2, '2026-10-14'],
			[3, '2026-10-07'],
			[4, '2026-01-01']
		]);
		expect(pruneSeen([1, 2, 3, 4, 5], firstListed, RECENT)).toEqual([1, 2]);
	});
});

describe('nextLastSeen', () => {
	it('moves forward only', () => {
		expect(nextLastSeen(undefined, '2026-10-14')).toBe('2026-10-14');
		expect(nextLastSeen('2026-10-14', '2026-10-21')).toBe('2026-10-21');
		expect(nextLastSeen('2026-10-21', '2026-10-14')).toBe('2026-10-21');
		expect(nextLastSeen('2026-10-21', '2026-10-21')).toBe('2026-10-21');
	});
});

describe('isRollback', () => {
	// An older file than the one this device already showed means the server went back; the app must not roll back too.
	it('is true only for an incoming date older than the held one', () => {
		expect(isRollback('2026-10-21', '2026-10-14')).toBe(true);
		expect(isRollback('2026-10-21', '2026-10-21')).toBe(false);
		expect(isRollback('2026-10-14', '2026-10-21')).toBe(false);
		expect(isRollback(undefined, '2026-10-14')).toBe(false);
	});
});
