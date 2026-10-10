import { describe, it, expect, vi, afterEach } from 'vitest';
import { encodeCalendarSyncState, decodeCalendarSyncState, CalendarSchemaError } from './codec';
import type { CalendarSyncState } from './types';

describe('calendar-sync codec', () => {
	const state: CalendarSyncState = {
		schemaVersion: 1,
		exclusions: { taskIds: ['va-disability-claim'], categories: ['medical'] }
	};

	it('round-trips a state through encode/decode', () => {
		expect(decodeCalendarSyncState(encodeCalendarSyncState(state))).toEqual(state);
	});

	it('rejects non-JSON bytes with an opaque error', () => {
		expect(() => decodeCalendarSyncState(new Uint8Array([0xff, 0xfe]))).toThrow(
			CalendarSchemaError
		);
	});

	it('rejects a wrong schemaVersion', () => {
		const bytes = new TextEncoder().encode(
			JSON.stringify({ schemaVersion: 2, exclusions: { taskIds: [], categories: [] } })
		);
		expect(() => decodeCalendarSyncState(bytes)).toThrow(CalendarSchemaError);
	});

	// The exclusion set decides what leaves for the calendar, so one the app cannot read makes the whole calendar
	// unavailable rather than being read as "nothing excluded".
	describe('an exclusion set it cannot read', () => {
		const withExclusions = (exclusions: unknown) =>
			new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, exclusions }));
		const unreadable: [string, unknown][] = [
			['missing', undefined],
			['null', null],
			['a string', 'medical'],
			['an array', []],
			['taskIds missing', { categories: [] }],
			['categories missing', { taskIds: [] }],
			['taskIds not an array', { taskIds: 'a', categories: [] }],
			['categories not an array', { taskIds: [], categories: 'medical' }],
			['taskIds null', { taskIds: null, categories: [] }],
			['a non-string in taskIds', { taskIds: ['a', 1], categories: [] }],
			['a null in categories', { taskIds: [], categories: [null] }],
			['an object in categories', { taskIds: [], categories: [{}] }]
		];
		for (const [name, exclusions] of unreadable) {
			it(`throws for ${name}`, () => {
				expect(() => decodeCalendarSyncState(withExclusions(exclusions))).toThrow(
					CalendarSchemaError
				);
			});
		}

		// Types only, never membership: a category name an older release wrote must still read.
		it('still reads a category name this release does not know, and a key it does not know', () => {
			const s = decodeCalendarSyncState(
				withExclusions({ taskIds: ['t'], categories: ['retired-category'], extra: 1 })
			);
			expect(s.exclusions.categories).toEqual(['retired-category']);
			expect(s.exclusions.taskIds).toEqual(['t']);
		});
	});

	describe('a card it cannot read', () => {
		const withCard = (card: unknown) =>
			new TextEncoder().encode(
				JSON.stringify({
					schemaVersion: 1,
					exclusions: { taskIds: [], categories: ['medical'] },
					card
				})
			);

		it('keeps a card holding a dismissal time and a count', () => {
			const card = { dismissedAt: 1716700000000, dismissCount: 2 };
			expect(decodeCalendarSyncState(withCard(card)).card).toEqual(card);
		});

		const bad: [string, unknown][] = [
			['a string', 'x'],
			['an array', []],
			['a number', 7],
			['null', null],
			['a time that is not a number', { dismissedAt: '1', dismissCount: 1 }],
			['a count that is not a number', { dismissedAt: 1, dismissCount: '1' }],
			['a missing count', { dismissedAt: 1 }],
			['a missing time', { dismissCount: 1 }],
			['an empty object', {}]
		];
		for (const [name, card] of bad) {
			it(`drops ${name} and keeps the rest of the record`, () => {
				const s = decodeCalendarSyncState(withCard(card));
				expect('card' in s).toBe(false);
				expect(s.exclusions.categories).toEqual(['medical']);
			});
		}
	});

	it('drops a malformed lastAdd at decode, keeping the rest of the record', () => {
		const bytes = new TextEncoder().encode(
			JSON.stringify({
				schemaVersion: 1,
				exclusions: { taskIds: [], categories: ['medical'] },
				lastAdd: 'x'
			})
		);
		const s = decodeCalendarSyncState(bytes);
		expect(s.lastAdd).toBeUndefined();
		expect('lastAdd' in s).toBe(false);
		expect(s.exclusions.categories).toEqual(['medical']);
	});

	it('drops a lastAdd with any entry it cannot trust, field by field', () => {
		const good = {
			taskId: 'a',
			moment: 'last',
			title: 't',
			isoDate: '2026-12-01',
			addedOn: '2026-10-04'
		};
		for (const bad of [
			null,
			{ ...good, taskId: 1 },
			{ ...good, moment: 'later' },
			{ ...good, title: 2 },
			{ ...good, isoDate: 'soon' },
			{ ...good, addedOn: '10/04/2026' }
		]) {
			const bytes = new TextEncoder().encode(
				JSON.stringify({
					schemaVersion: 1,
					exclusions: { taskIds: [], categories: [] },
					lastAdd: [good, bad]
				})
			);
			expect(decodeCalendarSyncState(bytes).lastAdd, JSON.stringify(bad)).toBeUndefined();
		}
	});

	// Only a tampered store holds these, but each must read as "no record yet", never a throw: a repeated entry would
	// break the list's keyed rows, and a date that names no day would be shown as some other day.
	const good = {
		taskId: 'a',
		moment: 'last',
		title: 't',
		isoDate: '2026-12-01',
		addedOn: '2026-10-04'
	};
	const untrusted: [string, unknown[]][] = [
		['a date held in an array', [{ ...good, isoDate: ['2026-12-01'] }]],
		// JSON can give an object its own toString; turning that object into text throws.
		['a date held in an object', [{ ...good, isoDate: { toString: 0 } }]],
		['an add day held in an object', [{ ...good, addedOn: { toString: 0 } }]],
		['a day the month does not have', [{ ...good, isoDate: '2026-02-30' }]],
		['a month that does not exist', [{ ...good, addedOn: '2026-13-01' }]],
		['text after the date', [{ ...good, isoDate: '2026-12-01x' }]],
		['the same event twice', [good, { ...good, addedOn: '2026-10-05' }]]
	];
	for (const [name, lastAdd] of untrusted) {
		it(`drops a lastAdd with ${name}`, () => {
			const bytes = new TextEncoder().encode(
				JSON.stringify({ schemaVersion: 1, exclusions: { taskIds: [], categories: [] }, lastAdd })
			);
			expect(() => decodeCalendarSyncState(bytes)).not.toThrow();
			expect(decodeCalendarSyncState(bytes).lastAdd).toBeUndefined();
		});
	}

	describe('in a time zone east of UTC', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		// Local midnight in Tokyo is still the day before in UTC, so a check that read the date as local time would
		// turn every day the app wrote into the one before it and drop the whole record.
		it('keeps a well-formed lastAdd', () => {
			vi.stubEnv('TZ', 'Asia/Tokyo');
			expect(new Date('2026-10-03T23:30:00Z').getHours()).toBe(8); // the zone took effect
			const lastAdd = [good];
			const bytes = new TextEncoder().encode(
				JSON.stringify({ schemaVersion: 1, exclusions: { taskIds: [], categories: [] }, lastAdd })
			);
			expect(decodeCalendarSyncState(bytes).lastAdd).toEqual(lastAdd);
		});
	});

	it('keeps a well-formed lastAdd', () => {
		const lastAdd = [
			{
				taskId: 'a',
				moment: 'last',
				title: 'Last day: a',
				isoDate: '2026-12-01',
				addedOn: '2026-10-04'
			}
		];
		const bytes = new TextEncoder().encode(
			JSON.stringify({ schemaVersion: 1, exclusions: { taskIds: [], categories: [] }, lastAdd })
		);
		expect(decodeCalendarSyncState(bytes).lastAdd).toEqual(lastAdd);
	});

	it('keeps an entry for every moment an event can mark', () => {
		const lastAdd = (['opens', 'changes', 'last', 'aim', 'leave'] as const).map((moment) => ({
			taskId: 'a',
			moment,
			title: `${moment}: a`,
			isoDate: '2026-12-01',
			addedOn: '2026-10-04'
		}));
		const bytes = new TextEncoder().encode(
			JSON.stringify({ schemaVersion: 1, exclusions: { taskIds: [], categories: [] }, lastAdd })
		);
		expect(decodeCalendarSyncState(bytes).lastAdd).toEqual(lastAdd);
	});
});
