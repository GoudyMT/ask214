import { decodeCalendarSyncState } from '../calendar/codec';
import { decodeProfile, encodeProfile } from '../profile/codec';
import { decodeEaos, parseEaosAtRead } from '../profile/eaos';
import { zeroizeRecord } from '../profile/lifecycle';
import type { ProfileV1 } from '../profile/types';
import {
	BRANCHES,
	DELIVERY,
	DURATIONS,
	INDUSTRIES,
	KINDS,
	type Listing
} from '../skillbridge-finder/contract/listing';
import { STATE_CODES, isIsoDate, type StateCode } from '../skillbridge-finder/contract/places';
import { validateListing } from '../skillbridge-finder/contract/validate';
import { decodeFinderRecord } from '../skillbridge-finder/state/codec';
import {
	MAX_COMPARE,
	MAX_SAVED,
	type FinderFilters,
	type FinderPlace,
	type FinderRadius,
	type FinderRecord,
	type FinderSavedItem,
	type FinderSetup
} from '../skillbridge-finder/state/types';
import { KNOWN_TASK_IDS } from '../timeline/known-task-ids';
import { SKILLBRIDGE_PLAN_KEY } from '../timeline/skillbridge-key';
import { decodeTimelineState, isSnoozeDate } from '../timeline/state-codec';
import type { TaskCategory, TaskStatus, TimelineState, TimelineTaskState } from '../timeline/types';
import { b64DecodeStrict } from './envelope';
import { CARRIED_STORES, OPTIONAL_CARRIED_STORES } from './manifest';
import { MAX_NOTE_UNITS } from './note-cap';
import { compareVersions, isAppVersion } from './version';

/**
 * The one wall between a decrypted backup and the person's stored data. It checks the file field by field against
 * exactly what this version of the app writes, and refuses anything else: an extra field, a wrong type, an unknown
 * task, a value no screen can produce. It never repairs, trims or guesses, and it returns the record it checked as
 * new objects built from the allowed keys, never the object it was handed.
 *
 * Order: the file is a plain object; `backupSchema` is read first, so a file from a newer format says "update the
 * app" whatever else it holds; `appVersion` has the one shape package.json writes; then the strict check below. A
 * refusal in that check is "update the app" when the file names a newer app than this one (its fields may be ones
 * this version has never heard of), and "part of it cannot be read" otherwise.
 *
 * Fixed depth, no generic walk: the check enters only the containers it knows, at the depth it knows (the card is four
 * levels in, a task five, the entries of an exclusion list six). At each one it checks the type (plain object or array), then the
 * exact own keys, then each value's type BEFORE going into it, so a hostile 100,000-deep array is refused at its
 * first level and never entered. A time is only a whole number in range, never compared with the clock, so this reads
 * no clock.
 *
 * Why the shipped decoders run on every store that passes: this check and the decoders must never disagree about a
 * record. A store passes only if its shipped decoder, reading the validated record's exact JSON text, gives back the
 * same record (for the profile, the shipped encoder writes the decoded record back to the same text). If a decoder
 * would drop, rewrite or reject something here accepted, that store is refused.
 *
 * Rules that keep a backup readable forever. Within `backupSchema` 1 this check may only be WIDENED. Anything that
 * tightens it, a store `schemaVersion` change, or a field that starts or stops being written bumps `backupSchema` in
 * the same change, with the migration for the old files. A new OPTIONAL store key, which older files simply lack, is a
 * widening: an older app refuses a file that holds it as "update the app" (the file names a newer version), which is
 * the intended answer. A new public setter on a store joins the writer-corpus test, which writes every record the
 * setters can make and validates it, and fails review unless it is added there.
 */

export type RefusedStore = 'profile' | 'timeline' | 'calendar' | 'finder';

/** The profile as the codec writes it: the dates are base64 text, exactly as in the file. */
export type ValidProfile = {
	schemaVersion: 1;
	generation: number;
	lastSeenAt: number;
	setupIntent: 'completed';
	setupIntentChangedAt: number | null;
	eaos: string;
	skillbridgeStart?: string;
	terminalLeaveStart?: string;
};

export type ValidCalendar = {
	schemaVersion: 1;
	exclusions: { taskIds: string[]; categories: TaskCategory[] };
	card?: { dismissedAt: number; dismissCount: number };
};

/** The finder record as export writes it: the four known keys and their known shapes, nothing a newer release added. */
export type ValidFinder = FinderRecord;

export type ValidInner = {
	appVersion: string;
	backupSchema: 1;
	createdAt: number;
	stores: {
		profile: ValidProfile;
		'timeline-state': TimelineState | null;
		'calendar-sync': ValidCalendar | null;
		/** Absent in a file made before the finder existed. */
		'skillbridge-finder'?: ValidFinder;
	};
};

export type ValidationResult =
	| { ok: true; inner: ValidInner }
	| { ok: false; code: 'E_CONTENT_INVALID' | 'E_NEWER_VERSION'; store?: RefusedStore };

type Bag = Record<string, unknown>;

// The largest time a JavaScript Date holds, so `new Date(t)` is always a real date once a time passes.
const MAX_TIME = 8.64e15;
const MAX_DISMISS_COUNT = 10_000;

// A record over every value, so a new status or category fails the type-check until it is decided here.
const STATUS_KEYS: Record<TaskStatus, true> = { done: true, skipped: true, snoozed: true };
const CATEGORY_KEYS: Record<TaskCategory, true> = {
	medical: true,
	admin: true,
	benefits: true,
	career: true,
	finance: true
};
const STATUSES: ReadonlySet<string> = new Set(Object.keys(STATUS_KEYS));
const CATEGORIES: ReadonlySet<string> = new Set(Object.keys(CATEGORY_KEYS));
const TASK_IDS: ReadonlySet<string> = new Set(KNOWN_TASK_IDS);

const INNER_KEYS = ['appVersion', 'backupSchema', 'createdAt', 'stores'] as const;
const PROFILE_REQUIRED = [
	'eaos',
	'generation',
	'lastSeenAt',
	'schemaVersion',
	'setupIntent',
	'setupIntentChangedAt'
] as const;
const PROFILE_DATES = ['skillbridgeStart', 'terminalLeaveStart'] as const;
const TASK_FIELDS = ['notes', 'snoozeUntil', 'status'] as const;
// The Timeline never shows a note for the SkillBridge plan's record, and the store refuses to write one.
const PLAN_FIELDS = ['snoozeUntil', 'status'] as const;

const isObject = (v: unknown): v is Bag => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The own keys of `obj` are all of `required` and nothing outside `required` and `optional`. */
function keysAre(obj: Bag, required: readonly string[], optional: readonly string[] = []): boolean {
	return (
		required.every((key) => Object.hasOwn(obj, key)) &&
		Object.keys(obj).every((key) => required.includes(key) || optional.includes(key))
	);
}

function isInteger(v: unknown, min: number, max: number): v is number {
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}

const isTime = (v: unknown): v is number => isInteger(v, 0, MAX_TIME);
const isTimeOrNull = (v: unknown): v is number | null => v === null || isTime(v);

/**
 * A date as the profile stores it: base64 of an ISO day the Settings read check (parseEaosAtRead) accepts. The base64
 * is the envelope's strict kind (the one reader that also survives a multi-megabyte value), which refuses a last
 * group with spare bits set: a second spelling of the same bytes that the shipped encoder never writes.
 */
function isStoredDate(v: unknown): v is string {
	if (typeof v !== 'string') return false;
	const bytes = b64DecodeStrict(v);
	if (bytes === null) return false;
	try {
		parseEaosAtRead(decodeEaos(bytes));
		return true;
	} catch {
		return false;
	} finally {
		bytes.fill(0);
	}
}

/** The JSON text of a value with every object's keys in sorted order, so two equal records give equal text. */
function sortedJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v
	);
}

const utf8 = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** The shipped decoder reads the validated record's exact bytes and gets the same record back. */
function decodesToSame(validated: unknown, decode: (bytes: Uint8Array) => unknown): boolean {
	try {
		return sortedJson(decode(utf8(validated))) === sortedJson(validated);
	} catch {
		return false;
	}
}

/** Only the keys the codec writes for a finished setup; every field no screen writes, and the backup mark, refuses. */
function readProfile(raw: unknown): ValidProfile | null {
	if (!isObject(raw) || !keysAre(raw, PROFILE_REQUIRED, PROFILE_DATES)) return null;
	const { schemaVersion, generation, lastSeenAt, setupIntent, setupIntentChangedAt, eaos } = raw;
	if (schemaVersion !== 1 || setupIntent !== 'completed') return null;
	// The writer replaces the generation, so only its shape is checked.
	if (!isInteger(generation, 1, Number.MAX_SAFE_INTEGER)) return null;
	if (!isTime(lastSeenAt) || !isTimeOrNull(setupIntentChangedAt) || !isStoredDate(eaos))
		return null;
	const profile: ValidProfile = {
		schemaVersion: 1,
		generation,
		lastSeenAt,
		setupIntent: 'completed',
		setupIntentChangedAt,
		eaos
	};
	for (const key of PROFILE_DATES) {
		if (!Object.hasOwn(raw, key)) continue;
		const date = raw[key];
		if (!isStoredDate(date)) return null;
		profile[key] = date;
	}
	// The decoder gives bytes, so the shipped encoder turns them back into the codec's text. The decoded record holds
	// the person's dates as bytes, so it and the buffers around it are wiped before this returns.
	const wire = utf8(profile);
	let decoded: ProfileV1 | undefined;
	let written: Uint8Array | undefined;
	try {
		decoded = decodeProfile(wire);
		written = encodeProfile(decoded);
		return new TextDecoder().decode(written) === sortedJson(profile) ? profile : null;
	} catch {
		return null;
	} finally {
		if (decoded) zeroizeRecord(decoded);
		written?.fill(0);
		wire.fill(0);
	}
}

function readTask(id: string, raw: unknown): TimelineTaskState | null {
	if (!isObject(raw)) return null;
	const fields: readonly string[] = id === SKILLBRIDGE_PLAN_KEY ? PLAN_FIELDS : TASK_FIELDS;
	const keys = Object.keys(raw);
	if (keys.length === 0 || !keys.every((key) => fields.includes(key))) return null;
	const task: TimelineTaskState = {};
	if (Object.hasOwn(raw, 'status')) {
		const status = raw.status;
		if (typeof status !== 'string' || !STATUSES.has(status)) return null;
		task.status = status as TaskStatus;
	}
	if (Object.hasOwn(raw, 'snoozeUntil')) {
		// A snooze date belongs to a snoozed task; a snoozed task may have none (the store writes that too).
		if (task.status !== 'snoozed' || !isSnoozeDate(raw.snoozeUntil)) return null;
		task.snoozeUntil = raw.snoozeUntil;
	}
	if (Object.hasOwn(raw, 'notes')) {
		// Any non-empty string is a note, even blank space: that is what the store keeps. No trimming.
		const notes = raw.notes;
		if (typeof notes !== 'string' || notes.length === 0 || notes.length > MAX_NOTE_UNITS)
			return null;
		task.notes = notes;
	}
	return task;
}

function readTimeline(raw: unknown): TimelineState | null {
	if (!isObject(raw) || !keysAre(raw, ['schemaVersion', 'tasks'])) return null;
	const stored = raw.tasks;
	if (raw.schemaVersion !== 1 || !isObject(stored)) return null;
	const tasks: Record<string, TimelineTaskState> = {};
	for (const id of Object.keys(stored)) {
		// A task id this release ever shipped, or the SkillBridge plan's key; the id is known before its value is read.
		if (id !== SKILLBRIDGE_PLAN_KEY && !TASK_IDS.has(id)) return null;
		const task = readTask(id, stored[id]);
		if (task === null) return null;
		tasks[id] = task;
	}
	const timeline: TimelineState = { schemaVersion: 1, tasks };
	return decodesToSame(timeline, decodeTimelineState) ? timeline : null;
}

/** A list of unique known values. */
function readList(raw: unknown, known: ReadonlySet<string>): string[] | null {
	if (!Array.isArray(raw)) return null;
	const list: string[] = [];
	for (const entry of raw as unknown[]) {
		if (typeof entry !== 'string' || !known.has(entry)) return null;
		list.push(entry);
	}
	return new Set(list).size === list.length ? list : null;
}

function readCalendar(raw: unknown): ValidCalendar | null {
	// `lastAdd` is this device's own bookkeeping (events handed to this phone's calendar), so a file never carries it.
	if (!isObject(raw) || !keysAre(raw, ['exclusions', 'schemaVersion'], ['card'])) return null;
	const stored = raw.exclusions;
	if (raw.schemaVersion !== 1 || !isObject(stored) || !keysAre(stored, ['categories', 'taskIds'])) {
		return null;
	}
	const taskIds = readList(stored.taskIds, TASK_IDS);
	const categories = readList(stored.categories, CATEGORIES);
	if (taskIds === null || categories === null) return null;
	const calendar: ValidCalendar = {
		schemaVersion: 1,
		exclusions: { taskIds, categories: categories as TaskCategory[] }
	};
	if (Object.hasOwn(raw, 'card')) {
		const card = raw.card;
		if (!isObject(card) || !keysAre(card, ['dismissCount', 'dismissedAt'])) return null;
		const { dismissedAt, dismissCount } = card;
		if (!isTime(dismissedAt) || !isInteger(dismissCount, 0, MAX_DISMISS_COUNT)) return null;
		calendar.card = { dismissedAt, dismissCount };
	}
	return decodesToSame(calendar, decodeCalendarSyncState) ? calendar : null;
}

const ZIP_RE = /^\d{5}$/;
const STATE_SET: ReadonlySet<unknown> = new Set(STATE_CODES);
const RADII: ReadonlySet<unknown> = new Set([25, 50, 100, 'any']);
const SETUP_KEYS = ['place', 'radius', 'territories', 'overseas'] as const;
// In the order export writes them; each list holds each value once.
const FILTER_LISTS: readonly (readonly [keyof FinderFilters, ReadonlySet<unknown>])[] = [
	['industries', new Set(INDUSTRIES)],
	['branches', new Set(BRANCHES)],
	['durations', new Set(DURATIONS)],
	['kinds', new Set(KINDS)],
	['delivery', new Set(Object.values(DELIVERY))]
];

/** Only the two places the finder writes: a ZIP of five digits, or a state or territory code. */
function readPlace(raw: unknown): FinderPlace | null {
	if (!isObject(raw)) return null;
	if (raw.kind === 'zip') {
		if (!keysAre(raw, ['kind', 'zip']) || typeof raw.zip !== 'string' || !ZIP_RE.test(raw.zip)) {
			return null;
		}
		return { kind: 'zip', zip: raw.zip };
	}
	if (raw.kind === 'state') {
		if (!keysAre(raw, ['kind', 'state']) || !STATE_SET.has(raw.state)) return null;
		return { kind: 'state', state: raw.state as StateCode };
	}
	return null;
}

function readSetup(raw: unknown): FinderSetup | null {
	if (!isObject(raw) || !keysAre(raw, [], SETUP_KEYS)) return null;
	const setup: FinderSetup = {};
	if (Object.hasOwn(raw, 'place')) {
		const place = readPlace(raw.place);
		if (place === null) return null;
		setup.place = place;
	}
	if (Object.hasOwn(raw, 'radius')) {
		if (!RADII.has(raw.radius)) return null;
		setup.radius = raw.radius as FinderRadius;
	}
	for (const flag of ['territories', 'overseas'] as const) {
		if (!Object.hasOwn(raw, flag)) continue;
		const value = raw[flag];
		if (typeof value !== 'boolean') return null;
		setup[flag] = value;
	}
	return setup;
}

function readFilters(raw: unknown): FinderFilters | null {
	if (
		!isObject(raw) ||
		!keysAre(
			raw,
			[],
			FILTER_LISTS.map(([key]) => key)
		)
	)
		return null;
	const filters: Record<string, unknown[]> = {};
	for (const [key, allowed] of FILTER_LISTS) {
		if (!Object.hasOwn(raw, key)) continue;
		const list = raw[key];
		// The length is checked before the list is walked: a list of a million entries is refused at its first line.
		if (!Array.isArray(list) || list.length > allowed.size) return null;
		const values: unknown[] = [];
		for (const value of list as unknown[]) {
			if (!allowed.has(value)) return null;
			values.push(value);
		}
		if (new Set(values).size !== values.length) return null;
		filters[key] = values;
	}
	return filters as FinderFilters;
}

function readSaved(raw: unknown): FinderSavedItem[] | null {
	if (!Array.isArray(raw) || raw.length > MAX_SAVED) return null;
	const saved: FinderSavedItem[] = [];
	const ids = new Set<number>();
	for (const item of raw as unknown[]) {
		if (!isObject(item) || !keysAre(item, ['facts', 'id', 'savedOn'])) return null;
		const { id, savedOn, facts } = item;
		if (!isInteger(id, 1, Number.MAX_SAFE_INTEGER) || ids.has(id) || !isIsoDate(savedOn)) {
			return null;
		}
		// The listing is kept whole, so it passes the same contract the weekly files do, and is the one the item names.
		if (!isObject(facts) || validateListing(facts).length > 0 || facts.i !== id) return null;
		ids.add(id);
		saved.push({ id, savedOn, facts: structuredClone(facts) as Listing });
	}
	return saved;
}

function readCompare(raw: unknown): number[] | null {
	if (!Array.isArray(raw) || raw.length > MAX_COMPARE) return null;
	const picks: number[] = [];
	for (const id of raw as unknown[]) {
		if (!isInteger(id, 1, Number.MAX_SAFE_INTEGER)) return null;
		picks.push(id);
	}
	return new Set(picks).size === picks.length ? picks : null;
}

/**
 * Exactly what export writes for the finder: the four known keys and their known shapes. A key a newer release added,
 * at any depth, refuses here (as "update the app" when the file names a newer app).
 */
function readFinder(raw: unknown): ValidFinder | null {
	if (
		!isObject(raw) ||
		!keysAre(
			raw,
			['finderCompare', 'finderSaved', 'schemaVersion'],
			['finderFilters', 'finderSetup']
		)
	) {
		return null;
	}
	if (raw.schemaVersion !== 1) return null;
	const finderSaved = readSaved(raw.finderSaved);
	const finderCompare = readCompare(raw.finderCompare);
	if (finderSaved === null || finderCompare === null) return null;
	const finder: ValidFinder = { schemaVersion: 1, finderSaved, finderCompare };
	if (Object.hasOwn(raw, 'finderSetup')) {
		const finderSetup = readSetup(raw.finderSetup);
		if (finderSetup === null) return null;
		finder.finderSetup = finderSetup;
	}
	if (Object.hasOwn(raw, 'finderFilters')) {
		const finderFilters = readFilters(raw.finderFilters);
		if (finderFilters === null) return null;
		finder.finderFilters = finderFilters;
	}
	return decodesToSame(finder, decodeFinderRecord) ? finder : null;
}

/** The checked file, or the store it was refused at (none when the refusal is the file's own frame). */
function checkInner(
	inner: Bag,
	appVersion: string
): { inner: ValidInner } | { store?: RefusedStore } {
	if (!keysAre(inner, INNER_KEYS) || !isTime(inner.createdAt)) return {};
	const stores = inner.stores;
	if (!isObject(stores) || !keysAre(stores, CARRIED_STORES, OPTIONAL_CARRIED_STORES)) return {};

	// A backup always comes from a finished setup, so the profile is never absent; the other two may be.
	const profile = readProfile(stores.profile);
	if (profile === null) return { store: 'profile' };
	const rawTimeline = stores['timeline-state'];
	const timeline = rawTimeline === null ? null : readTimeline(rawTimeline);
	if (rawTimeline !== null && timeline === null) return { store: 'timeline' };
	const rawCalendar = stores['calendar-sync'];
	const calendar = rawCalendar === null ? null : readCalendar(rawCalendar);
	if (rawCalendar !== null && calendar === null) return { store: 'calendar' };
	// The finder may be absent (a file from before it existed); present, it is a record and never null.
	const hasFinder = Object.hasOwn(stores, 'skillbridge-finder');
	const finder = hasFinder ? readFinder(stores['skillbridge-finder']) : null;
	if (hasFinder && finder === null) return { store: 'finder' };

	return {
		inner: {
			appVersion,
			backupSchema: 1,
			createdAt: inner.createdAt,
			stores: {
				profile,
				'timeline-state': timeline,
				'calendar-sync': calendar,
				...(finder && { 'skillbridge-finder': finder })
			}
		}
	};
}

const invalid = (store?: RefusedStore): ValidationResult => ({
	ok: false,
	code: 'E_CONTENT_INVALID',
	...(store && { store })
});

export function validateInner(value: unknown): ValidationResult {
	if (!isObject(value)) return invalid();
	if (!Object.hasOwn(value, 'backupSchema')) return invalid();
	const schema = value.backupSchema;
	if (typeof schema !== 'number' || !Number.isSafeInteger(schema)) return invalid();
	if (schema > 1) return { ok: false, code: 'E_NEWER_VERSION' };
	if (schema !== 1) return invalid();
	if (!Object.hasOwn(value, 'appVersion') || !isAppVersion(value.appVersion)) return invalid();
	const appVersion = value.appVersion;

	const checked = checkInner(value, appVersion);
	if ('inner' in checked) return { ok: true, inner: checked.inner };
	if (compareVersions(appVersion, __APP_VERSION__) > 0)
		return { ok: false, code: 'E_NEWER_VERSION' };
	return invalid(checked.store);
}
