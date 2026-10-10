import type { CalendarSyncState, HandedOverEvent, EventMoment, TaskExclusions } from './types';
import { handedOverKey } from './handed-over';
import { isDay } from '../timeline/day-math';

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

function isStrings(v: unknown): boolean {
	return Array.isArray(v) && v.every((s: unknown) => typeof s === 'string');
}

/** The dismissal bookkeeping the store writes, both numbers; anything else reads as no dismissal yet. */
function isCard(v: unknown): boolean {
	return (
		typeof v === 'object' &&
		v !== null &&
		typeof (v as { dismissedAt?: unknown }).dismissedAt === 'number' &&
		typeof (v as { dismissCount?: unknown }).dismissCount === 'number'
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
	const state = { ...parsed } as CalendarSyncState & { lastAdd?: unknown; card?: unknown };
	// Types only, never membership: a category name an older release wrote must still read.
	const { taskIds, categories } = (state.exclusions ?? {}) as Partial<TaskExclusions>;
	if (!isStrings(taskIds) || !isStrings(categories)) throw new CalendarSchemaError();
	if (state.lastAdd !== undefined && !isHandedOverList(state.lastAdd)) delete state.lastAdd;
	if (state.card !== undefined && !isCard(state.card)) delete state.card;
	return state as CalendarSyncState;
}
