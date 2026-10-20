import { localTodayIso } from '../timeline/day-math';
import { formatTimelineDate } from '../timeline/format-date';

/**
 * The earliest time a backup's date is believed. A backup stamped before it was made on a device whose clock was set
 * to before the app existed, so that date is not shown. Set to the day the format froze, which is on or before the
 * release, so no real backup is ever dated "unknown" for being early.
 */
export const BACKUP_RELEASE_DATE = Date.UTC(2026, 9, 18);

/**
 * A backup's date as the person reads it: the Timeline's "Mon D, YYYY" for the calendar day where they live, or
 * "date unknown" for a time before the release. A file is labelled, never refused, for its date. `ms` is a time the
 * validator has already checked, and this reads no clock: the date comes only from `ms`.
 */
export function formatBackupDate(ms: number): string {
	if (ms < BACKUP_RELEASE_DATE) return 'date unknown';
	return formatTimelineDate(localTodayIso(new Date(ms)));
}
