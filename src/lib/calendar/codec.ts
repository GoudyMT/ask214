import type { CalendarSyncState, HandedOverEvent, EventMoment } from './types';
import { handedOverKey } from './handed-over';

const SCHEMA_VERSION = 1;
// A record over every moment, so a new moment fails the type-check until it is accepted here too.
const MOMENT_KEYS: Record<EventMoment, true> = {
	opens: true,
	changes: true,
	last: true,
	aim: true,
	leave: true
};
const MOMENTS: ReadonlySet<string> = new Set(Object.keys(MOMENT_KEYS));

/**
 * A day as the app writes it, YYYY-MM-DD: only a string a UTC round trip gives back unchanged. The string check
 * comes first, because turning an object into text can throw. A date with extra text, or one that names no day
 * (2026-02-30: some engines roll it over to March 2, others give no date at all), fails. UTC on both sides, so the
 * device's time zone cannot move the day.
 */
function isDay(v: unknown): boolean {
	if (typeof v !== 'string') return false;
	const t = new Date(`${v}T00:00:00Z`);
	return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}

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
				isDay((e as HandedOverEvent).isoDate) &&
				isDay((e as HandedOverEvent).addedOn)
		) &&
		// The list keys its rows by this identity, so a repeated event would break the page.
		new Set(v.map((e: HandedOverEvent) => handedOverKey(e))).size === v.length
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
