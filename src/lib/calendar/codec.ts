import type { CalendarSyncState } from './types';

const SCHEMA_VERSION = 1;

export class CalendarSchemaError extends Error {
	constructor() {
		super('E_CALENDAR_SCHEMA');
		this.name = 'CalendarSchemaError';
	}
}

export function encodeCalendarSyncState(state: CalendarSyncState): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(state));
}

export function decodeCalendarSyncState(bytes: Uint8Array): CalendarSyncState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new CalendarSchemaError();
	}
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		(parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
	) {
		throw new CalendarSchemaError();
	}
	return parsed as CalendarSyncState;
}
