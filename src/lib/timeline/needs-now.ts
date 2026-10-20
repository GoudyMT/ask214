import { CLOSING_SOON_DAYS, isJustClosed, type TimelineItem } from './generate';
import { daysBetween } from './day-math';

/** How long a window counts as "just opened". */
export const JUST_OPENED_DAYS = 14;

export type NeedsNowGroups = {
	late: TimelineItem[];
	closingSoon: TimelineItem[];
	justClosed: TimelineItem[];
	justOpened: TimelineItem[];
	afterYouLeave: TimelineItem[];
};

/**
 * The status word for a task that cannot fit before the user leaves the command: the one the card, the group heading
 * here and Home's row all use. `leftCommand` is set from the leaving day on, so the word turns on that day.
 */
export function afterYouLeaveWord(item: TimelineItem): 'After you leave' | 'Since you left' {
	return item.leftCommand ? 'Since you left' : 'After you leave';
}

/**
 * The tasks that need attention now, each once, in its most urgent group. A late task stays until it is marked
 * done or skipped, or separation has passed; a closed one shows for 14 days with what remains possible; a window
 * that opened in the last 14 days is called out; a firm task that cannot fit before the user leaves the command is
 * listed under After you leave until separation. Statuses already carry the snooze rule, so a snoozed task appears
 * only when a firm warning overrides it. Items keep their timeline order.
 */
export function selectNeedsNow(items: TimelineItem[], todayIso: string): NeedsNowGroups {
	const groups: NeedsNowGroups = {
		late: [],
		closingSoon: [],
		justClosed: [],
		justOpened: [],
		afterYouLeave: []
	};
	for (const item of items) {
		if (item.status === 'late') groups.late.push(item);
		else if (item.status === 'closing-soon') groups.closingSoon.push(item);
		else if (item.status === 'changed') {
			if ((item.daysLeft ?? Infinity) <= CLOSING_SOON_DAYS) groups.closingSoon.push(item);
		} else if (item.status === 'after-you-leave') {
			// Only a firm task needs a word with the command now; a soft one stays out of the summary.
			if (item.def.kind !== 'soft') groups.afterYouLeave.push(item);
		} else if (item.status === 'closed') {
			if (isJustClosed(item, todayIso)) groups.justClosed.push(item);
		} else if (item.status === 'start-now') {
			if (daysBetween(item.windowStartDate, todayIso) < JUST_OPENED_DAYS)
				groups.justOpened.push(item);
		}
	}
	// Home names this group's first task and the Timeline draws the group in this order, so a task whose leaving day is
	// still ahead leads and both show the same word on top.
	groups.afterYouLeave.sort((a, b) => Number(!!a.leftCommand) - Number(!!b.leftCommand));
	return groups;
}
