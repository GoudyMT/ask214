import { downloadTextFile } from './download';
import { calendarFileName } from './delivery';
import { localTodayIso } from '../timeline/day-math';
import type { CalendarFile } from './build-ics';
import type { DesiredEvent } from './types';

type Recorder = {
	/** True once the app has locked: the stores' contents are out of memory. */
	readonly locked?: boolean;
	recordAdd(events: DesiredEvent[], addedOn: string, todayIso: string): Promise<void>;
};

/**
 * The one way both add buttons hand the calendar file over: the file first, then the record of exactly the events
 * in it. A failed record (a relock as the phone's app chooser takes over, a conflict with another tab) keeps the old
 * record, so the events in this file that the old record lacked go unlisted: if they go stale later, the list
 * cannot name them. A file finished after the app locked is dropped: a Lock means nothing personal leaves the app
 * after it, and the user adds again once unlocked.
 */
export async function handOver(
	file: CalendarFile,
	store: Recorder | null | undefined,
	now: Date,
	download: (ics: string) => void = (ics) =>
		downloadTextFile(calendarFileName(now), 'text/calendar', ics)
): Promise<void> {
	if (store?.locked) return;
	download(file.ics);
	const today = localTodayIso(now);
	try {
		await store?.recordAdd(file.events, today, today);
	} catch {
		// Kept on purpose: see above. Nothing to tell the user - the file did reach them.
	}
}
