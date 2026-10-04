import type { CalendarSyncState, HandedOverEvent, EventMoment } from './types';

const SCHEMA_VERSION = 1;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MOMENTS: ReadonlySet<EventMoment> = new Set(['opens', 'changes', 'last', 'aim', 'leave']);

/** A stored list the app wrote itself, checked anyway: a bad shape must read as "no record yet", never throw later. */
function isHandedOverList(v: unknown): v is HandedOverEvent[] {
	return (
		Array.isArray(v) &&
		v.every(
			(e: unknown) =>
				typeof e === 'object' &&
				e !== null &&
				typeof (e as HandedOverEvent).taskId === 'string' &&
				MOMENTS.has((e as HandedOverEvent).moment) &&
				typeof (e as HandedOverEvent).title === 'string' &&
				ISO_DATE.test(String((e as HandedOverEvent).isoDate)) &&
				ISO_DATE.test(String((e as HandedOverEvent).addedOn))
		)
	);
}

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
	const state = parsed as CalendarSyncState & { lastAdd?: unknown };
	if (state.lastAdd !== undefined && !isHandedOverList(state.lastAdd)) {
		const rest = { ...state };
		delete rest.lastAdd;
		return rest;
	}
	return state as CalendarSyncState;
}
