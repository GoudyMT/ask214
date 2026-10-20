import { formatTimelineDate } from './format-date';
import { afterYouLeaveWord, selectNeedsNow } from './needs-now';
import { generateTimeline, type DisplayStatus, type TimelineItem } from './generate';
import { TASK_DEFS } from './task-defs';
import type { TimelineState } from './types';
import type { PersonaFilters } from '../profile/persona';

/** One glance row on Home: a tool's name, a short count, and the one thing to know about it. */
export type HomeRow = {
	name: string;
	count?: string;
	/** Leads the detail; `hot` takes the danger colour, as the Timeline's urgent lines do. A word, never colour alone. */
	status?: { word: string; hot: boolean };
	detail: string;
};

/**
 * What Home knows about the timeline: locked carries nothing personal, so the row can show no task. A timeline that
 * failed needs none of this code: Home shows `FAILED_ROW` from `./load-home-glance`.
 */
export type TimelineGlance =
	{ kind: 'locked' } | { kind: 'ready'; items: TimelineItem[]; todayIso: string };

const NAME = 'Your timeline';

// The task card's own status words, for the statuses "Needs you now" can hold; After you leave / Since you left turns
// on the task, so it is worded by `afterYouLeaveWord`.
const STATUS_WORD: Partial<Record<DisplayStatus, string>> = {
	late: 'Late',
	'closing-soon': 'Closing soon',
	changed: 'Changed',
	closed: 'Closed',
	'start-now': 'Start now'
};

// Open today, so the first of these is the Next task, a window open now before an aim already passed; then the one
// that opens soonest; a snoozed one only after both.
const OPEN_NOW: ReadonlySet<DisplayStatus> = new Set(['start-now', 'changed']);
const OPENS_LATER: ReadonlySet<DisplayStatus> = new Set(['upcoming', 'after-you-leave']);

/** The date a Next task is known by, worded as its card words it (lower case, inside a sentence). */
function nextWhen(item: TimelineItem): string {
	const f = formatTimelineDate;
	switch (item.status) {
		case 'upcoming':
			return `opens ${f(item.windowStartDate)}`;
		case 'after-you-leave':
			// An opening already past is not news once the user has left; the card drops it too.
			return item.leftCommand?.opened
				? 'by your separation date'
				: `opens ${f(item.windowStartDate)}`;
		case 'start-now':
			return item.def.kind === 'soft'
				? `aim for ${f(item.aimDate ?? item.windowEndDate)}`
				: `last day ${f(item.windowEndDate)}`;
		case 'still-to-do':
			return item.aimLapsed ? 'still to do' : `aimed for ${f(item.windowEndDate)}`;
		case 'changed':
			return `last day ${f(item.finalEndDate ?? item.windowEndDate)}`;
		default:
			return `snoozed until ${f(item.snoozeUntil ?? item.targetDate)}`;
	}
}

/** A set-up user's timeline as the Timeline page builds it, ready for the row; null for a profile with no timeline. */
export function readyGlance(
	persona: PersonaFilters,
	state: TimelineState,
	now: Date
): TimelineGlance | null {
	const view = generateTimeline(persona, [...TASK_DEFS], state, now);
	if (!view.todayDate) return null;
	return { kind: 'ready', items: view.phases.flatMap((p) => p.items), todayIso: view.todayDate };
}

/**
 * The Timeline's row on Home. The count and the task it names come from "Needs you now" in its own order (Late,
 * Closing soon, After you leave, Just closed, Just opened), so Home and the Timeline always give the same number.
 * With nothing needing attention it names the next task: one open today, else the one that opens soonest, a snoozed
 * one only when neither exists; with nothing left to act on, it says so.
 */
export function timelineRow(glance: TimelineGlance): HomeRow {
	if (glance.kind === 'locked') {
		return { name: NAME, count: 'locked', detail: 'Unlock to see what is due' };
	}
	const g = selectNeedsNow(glance.items, glance.todayIso);
	const urgent = [
		...g.late,
		...g.closingSoon,
		...g.afterYouLeave,
		...g.justClosed,
		...g.justOpened
	];
	const first = urgent[0];
	if (first) {
		const n = urgent.length;
		return {
			name: NAME,
			count: `${n} ${n === 1 ? 'needs' : 'need'} you now`,
			status: {
				word:
					first.status === 'after-you-leave'
						? afterYouLeaveWord(first)
						: (STATUS_WORD[first.status] ?? first.status),
				hot: first.status !== 'start-now' && first.status !== 'after-you-leave'
			},
			detail: first.def.title
		};
	}
	const later = glance.items
		.filter((i) => OPENS_LATER.has(i.status))
		.sort((a, b) => a.windowStartDate.localeCompare(b.windowStartDate));
	const next =
		glance.items.find((i) => OPEN_NOW.has(i.status)) ??
		glance.items.find((i) => i.status === 'still-to-do') ??
		later[0] ??
		glance.items.find((i) => i.status === 'snoozed');
	if (next) {
		return {
			name: NAME,
			count: 'nothing needs you now',
			detail: `Next: ${next.def.title} - ${nextWhen(next)}`
		};
	}
	// A task that closed unanswered was missed, not done, so "all done" waits for every task to be done or skipped.
	return glance.items.every((i) => i.status === 'done' || i.status === 'skipped')
		? { name: NAME, count: 'all tasks done', detail: 'See what you finished' }
		: { name: NAME, count: 'nothing left to do', detail: 'See your timeline' };
}
