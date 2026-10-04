import type { TaskCategory } from '../timeline/types';
import type { CardDismissal } from './card-visibility';

/** Tasks/categories the user excludes from ALL calendar output (zero egress). */
export type TaskExclusions = {
	taskIds: string[];
	categories: TaskCategory[];
};

/**
 * The encrypted calendar-sync record (single self-row, id = 0). v1.0 holds only the exclusion
 * set. The Google two-way fields (per-task eventId map, syncToken, calendarId, connected flag,
 * card-dismissal timestamp) are added later as additive optional fields, so decode tolerates
 * their absence on existing records without a schemaVersion bump.
 */
export type CalendarSyncState = {
	schemaVersion: 1;
	exclusions: TaskExclusions;
	/** Timeline card dismissal bookkeeping; absent until the user first dismisses the card. */
	card?: CardDismissal;
};

/** Which moment of a task an event marks; it also keys the event's stable calendar ID. */
export type EventMoment = 'opens' | 'changes' | 'last' | 'aim' | 'leave';

/** One all-day event in the shared desired-set (feeds the .ics file and, later, Google). */
export type DesiredEvent = {
	taskId: string;
	moment: EventMoment;
	title: string; // the task title behind its moment prefix
	isoDate: string; // YYYY-MM-DD, never before today
	alarmDays: number[]; // alerts this many days before the event, only those still ahead
};
