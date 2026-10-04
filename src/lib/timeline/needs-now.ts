import { CLOSING_SOON_DAYS, type TimelineItem } from './generate';
import { daysBetween } from './day-math';

/** How long a window counts as "just opened", and a closed one as "just closed". */
export const JUST_OPENED_DAYS = 14;
export const JUST_CLOSED_DAYS = 14;

export type NeedsNowGroups = {
	late: TimelineItem[];
	closingSoon: TimelineItem[];
	justClosed: TimelineItem[];
	justOpened: TimelineItem[];
};

/**
 * The tasks that need attention now, each once, in its most urgent group. A late task stays until it is marked
 * done or skipped, or separation has passed; a closed one shows for 14 days with what remains possible; a window
 * that opened in the last 14 days is called out. Statuses already carry the snooze rule, so a snoozed task appears
 * only when a firm warning overrides it. Items keep their timeline order.
 */
export function selectNeedsNow(items: TimelineItem[], todayIso: string): NeedsNowGroups {
	const groups: NeedsNowGroups = { late: [], closingSoon: [], justClosed: [], justOpened: [] };
	for (const item of items) {
		if (item.status === 'late') groups.late.push(item);
		else if (item.status === 'closing-soon') groups.closingSoon.push(item);
		else if (item.status === 'changed') {
			if ((item.daysLeft ?? Infinity) <= CLOSING_SOON_DAYS) groups.closingSoon.push(item);
		} else if (item.status === 'closed') {
			const closedOn = item.finalEndDate ?? item.windowEndDate;
			if (daysBetween(closedOn, todayIso) <= JUST_CLOSED_DAYS) groups.justClosed.push(item);
		} else if (item.status === 'start-now') {
			if (daysBetween(item.windowStartDate, todayIso) < JUST_OPENED_DAYS)
				groups.justOpened.push(item);
		}
	}
	return groups;
}
