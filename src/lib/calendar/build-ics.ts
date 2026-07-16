import type { TimelineItem } from '../timeline/generate';
import type { TaskExclusions } from './types';
import { computeDesiredEvents } from './desired';
import { computeIcsUid } from './uid';
import { serializeIcs } from './ics';

/**
 * Project the generated timeline into the iCalendar text the OS hands to the user's calendar app:
 * the shared desired-set, stamped with each task's stable UID so a re-import updates rather than
 * duplicates. Shared by every surface that offers the add, so they cannot drift apart in what they
 * egress. `now` is injected for a deterministic DTSTAMP.
 */
export async function buildIcs(
	items: TimelineItem[],
	exclusions: TaskExclusions,
	now: Date
): Promise<string> {
	const desired = computeDesiredEvents(items, exclusions);
	const events = await Promise.all(
		desired.map(async (d) => ({
			title: d.title,
			isoDate: d.isoDate,
			uid: await computeIcsUid(d.taskId)
		}))
	);
	return serializeIcs(events, now);
}
