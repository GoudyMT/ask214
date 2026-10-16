import { encodeCalendarSyncState } from '../calendar/codec';
import type { CalendarSyncState } from '../calendar/types';
import { safeLog } from '../log/safelog';
import { encodeProfile } from '../profile/codec';
import type { ProfileV1 } from '../profile/types';
import { encodeTimelineState } from '../timeline/state-codec';
import { MAX_PADDED_PLAINTEXT_BYTES } from './caps';
import { MAX_NOTE_UNITS } from './note-cap';
import type { Snapshot } from './snapshot';
import { validateInner, type RefusedStore } from './validate';

export type ExportInnerResult =
	| { ok: true; bytes: Uint8Array }
	| { ok: false; code: 'E_CONTENT_TOO_LARGE'; taskId: string }
	| { ok: false; code: 'E_EXPORT_SELF_INVALID'; store: RefusedStore };

// The number the log carries for each store: fields hold numbers, never text.
const STORE_INDEX: Record<RefusedStore, number> = { profile: 0, timeline: 1, calendar: 2 };

/**
 * The JSON object a shipped encoder writes for a record, which is the shape the file holds. The encoder's bytes have
 * no use once they are read, so they are zeroed, whether or not the read succeeds.
 */
function asJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} finally {
		bytes.fill(0);
	}
}

const encodedLength = (value: string): number =>
	new TextEncoder().encode(JSON.stringify(value)).length;

/** The task whose note is the largest as it travels in the file, so escaped characters count at their full size. */
function largestNoteTask(snap: Snapshot): string {
	let taskId = '';
	let largest = -1;
	for (const [id, task] of Object.entries(snap.timeline?.tasks ?? {})) {
		const size = task.notes === undefined ? -1 : encodedLength(task.notes);
		if (size > largest) {
			largest = size;
			taskId = id;
		}
	}
	return taskId;
}

/**
 * The profile for the file. The backup mark (when this device last backed up and which saved states that matched)
 * describes this device and not the person's data, so it never travels.
 */
function fileProfile(profile: ProfileV1): unknown {
	const copy: ProfileV1 = { ...profile };
	delete copy.lastBackupAt;
	delete copy.backupGenProfile;
	delete copy.backupGenTimeline;
	delete copy.backupGenCalendar;
	return asJson(encodeProfile(copy));
}

/**
 * Built field by field, never as a copy of the stored record: `lastAdd` lists the events handed to THIS phone's
 * calendar app, so a file must not carry it, and a repeated entry some earlier release could save is written once.
 */
function fileCalendar(calendar: CalendarSyncState): unknown {
	const fresh: CalendarSyncState = {
		schemaVersion: calendar.schemaVersion,
		exclusions: {
			taskIds: [...new Set(calendar.exclusions.taskIds)],
			categories: [...new Set(calendar.exclusions.categories)]
		},
		...(calendar.card && { card: calendar.card })
	};
	return asJson(encodeCalendarSyncState(fresh));
}

/**
 * Turns a snapshot into the bytes that get sealed. The caller seals and then zeroes them, and zeroes the snapshot's
 * profile with `zeroizeRecord`: this reads the profile and never wipes it.
 *
 * Steps, each with its own refusal: a note over the limit is named first, before any check, because the store no longer
 * saves one and the person needs to hear which task to shorten. The file is built
 * from what the shipped encoders write, then run through the same check a restore uses; a refusal there is a fault in
 * the app, never a read failure (the stores read fine). Last, the size: the unpadded bytes must fit the cap.
 */
export function buildExportInner(snap: Snapshot, createdAt: number): ExportInnerResult {
	for (const [taskId, task] of Object.entries(snap.timeline?.tasks ?? {})) {
		if (task.notes !== undefined && task.notes.length > MAX_NOTE_UNITS) {
			return { ok: false, code: 'E_CONTENT_TOO_LARGE', taskId };
		}
	}

	const inner = {
		backupSchema: 1,
		// Written as given: a clock that is wrong is shown as it is, never replaced with a made-up date.
		createdAt,
		appVersion: __APP_VERSION__,
		stores: {
			profile: fileProfile(snap.profile),
			'timeline-state': snap.timeline && asJson(encodeTimelineState(snap.timeline)),
			'calendar-sync': snap.calendar && fileCalendar(snap.calendar)
		}
	};

	const checked = validateInner(inner);
	if (!checked.ok) {
		// A refusal of the file's own frame names no store; the profile is the record every file holds.
		const store = checked.store ?? 'profile';
		safeLog({ code: 'E_EXPORT_SELF_INVALID', fields: { store: STORE_INDEX[store] } });
		return { ok: false, code: 'E_EXPORT_SELF_INVALID', store };
	}

	// The record the check returned, so the bytes are exactly what passed it.
	const bytes = new TextEncoder().encode(JSON.stringify(checked.inner));
	if (bytes.length > MAX_PADDED_PLAINTEXT_BYTES) {
		bytes.fill(0);
		return { ok: false, code: 'E_CONTENT_TOO_LARGE', taskId: largestNoteTask(snap) };
	}
	return { ok: true, bytes };
}
