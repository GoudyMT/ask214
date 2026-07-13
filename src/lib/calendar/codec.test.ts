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
});
