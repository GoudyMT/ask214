import { describe, it, expect } from 'vitest';
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
});
