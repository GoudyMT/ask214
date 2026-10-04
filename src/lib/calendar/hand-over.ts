import { downloadTextFile } from './download';
import { calendarFileName } from './delivery';
import { localTodayIso } from '../timeline/day-math';
import type { CalendarFile } from './build-ics';
import type { DesiredEvent } from './types';

type Recorder = {
	recordAdd(events: DesiredEvent[], addedOn: string, todayIso: string): Promise<void>;
};

/**
 * The one way both add buttons hand the calendar file over: the file first, then the record of exactly the events
 * in it. A failed record (a relock as the phone's app chooser takes over, a conflict with another tab) keeps the old
 * record - the list then shows too much, never too little, which is the safe side.
 */
export async function handOver(
	file: CalendarFile,
	store: Recorder | null | undefined,
	now: Date,
	download: (ics: string) => void = (ics) =>
		downloadTextFile(calendarFileName(now), 'text/calendar', ics)
): Promise<void> {
	download(file.ics);
	const today = localTodayIso(now);
	try {
		await store?.recordAdd(file.events, today, today);
	} catch {
		// Kept on purpose: see above. Nothing to tell the user - the file did reach them.
	}
}
