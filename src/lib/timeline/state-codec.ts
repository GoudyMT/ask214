import { isDay } from './day-math';
import { SNOOZE_DATE_MAX } from './snooze';
import type { TimelineState, TimelineTaskState } from './types';

/**
 * Timeline-state encoding for AES-GCM input. Unlike the profile codec there are no
 * Uint8Array fields (status / snoozeUntil / notes are all JSON-native), so this is a
 * plain JSON encode - no base64, and no key-sorting (nothing hashes the plaintext, so
 * deterministic encoding is unnecessary here). schemaVersion lives INSIDE the encrypted
 * JSON and is checked by decode AFTER AES-GCM authentication (no plaintext header).
 */
const SCHEMA_VERSION = 1;

export class TimelineSchemaError extends Error {
	constructor() {
		super('E_TIMELINE_SCHEMA');
		this.name = 'TimelineSchemaError';
	}
}

export function encodeTimelineState(state: TimelineState): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(state));
}

/** A snooze date the calendar file can write: a real day, no later than the last one a snooze can name. */
export const isSnoozeDate = (v: unknown): v is string => isDay(v) && v <= SNOOZE_DATE_MAX;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One task as stored, or null when nothing readable is left. A field the app cannot read is dropped so the task still
 * shows; types only, never membership, so a status a newer release wrote survives this tab's next write. A snooze date
 * the calendar file cannot write goes with the snoozed status that rested on it: the date alone gone would leave a
 * snoozed task with no date, which the SkillBridge answer reads as a chosen "Not sure" that shows the steps.
 */
function readTask(raw: unknown): TimelineTaskState | null {
	if (!isPlainObject(raw)) return null;
	const task: Record<string, unknown> = {};
	// An own `__proto__` key, which JSON.parse can produce, would set the prototype instead of adding a key.
	for (const [key, value] of Object.entries(raw)) if (key !== '__proto__') task[key] = value;
	if (typeof task.status !== 'string') delete task.status;
	if (typeof task.notes !== 'string') delete task.notes;
	if ('snoozeUntil' in task && !isSnoozeDate(task.snoozeUntil)) {
		delete task.snoozeUntil;
		if (task.status === 'snoozed') delete task.status;
	}
	return Object.keys(task).length > 0 ? task : null;
}

export function decodeTimelineState(bytes: Uint8Array): TimelineState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new TimelineSchemaError();
	}
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		(parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
	) {
		throw new TimelineSchemaError();
	}
	const stored = (parsed as { tasks?: unknown }).tasks;
	if (!isPlainObject(stored)) throw new TimelineSchemaError();
	const tasks: Record<string, TimelineTaskState> = {};
	for (const [id, raw] of Object.entries(stored)) {
		const task = id === '__proto__' ? null : readTask(raw);
		if (task) tasks[id] = task;
	}
	return { schemaVersion: SCHEMA_VERSION, tasks };
}
