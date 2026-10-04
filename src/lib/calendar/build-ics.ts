import type { TimelineItem } from '../timeline/generate';
import type { TaskExclusions, DesiredEvent } from './types';
import { computeDesiredEvents } from './desired';
import { computeIcsUid } from './uid';
import { serializeIcs } from './ics';
import { localTodayIso } from '../timeline/day-math';

/**
 * Project the generated timeline into the iCalendar text the OS hands to the user's calendar app: one event per
 * moment of the shared desired-set, each with its alerts and a stable calendar ID. Shared by every surface that
 * offers the add, so they cannot drift apart in what they egress. `now` is injected for a deterministic DTSTAMP.
 */
export async function buildIcs(
	items: TimelineItem[],
	exclusions: TaskExclusions,
	now: Date
): Promise<string> {
	const desired = computeDesiredEvents(items, exclusions, localTodayIso(now));
	const events = await Promise.all(
		desired.map(async (d) => ({
			title: d.title,
			isoDate: d.isoDate,
			alarmDays: d.alarmDays,
			uid: await computeIcsUid(eventKey(d))
		}))
	);
	return serializeIcs(events, now);
}

/** "Last day", "Aim for" and "Before you leave" keep the task's original calendar ID, so an app that matches events
 *  by ID moves the one a user already added when a task stops (or starts) fitting; "Opens" and "Changes" are new
 *  events with IDs of their own. */
function eventKey(d: DesiredEvent): string {
	return d.moment === 'last' || d.moment === 'aim' || d.moment === 'leave'
		? d.taskId
		: `${d.taskId}:${d.moment}`;
}
