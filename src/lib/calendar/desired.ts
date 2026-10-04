import type { TimelineItem } from '../timeline/generate';
import { addDays } from '../timeline/day-math';
import type { TaskExclusions, DesiredEvent, EventMoment } from './types';

/** Alerts before a firm date, and before a soft task's aim, in days before the event. */
const FIRM_ALARM_DAYS = [30, 7, 1];
const SOFT_ALARM_DAYS = [7];

const PREFIX: Record<EventMoment, string> = {
	opens: 'Opens: ',
	changes: 'Changes: ',
	last: 'Last day: ',
	aim: 'Aim for: ',
	leave: 'Before you leave: '
};

/**
 * Project the timeline into the shared desired-event set: for each pending, non-excluded task, one event per
 * moment that is today or later. A soft task gets one "Aim for" event (its snooze date while snoozed); a firm
 * task gets "Opens" while its window is still ahead and "Last day" (a two-edge task also "Changes"), and a
 * snooze never moves those. A task that cannot fit before the user leaves the command gets one "Before you leave"
 * event on the last day there, and no Opens or Last day event. Alerts are kept only while still ahead, so an
 * import never fires a stale one. Pure + deterministic; `todayIso` injected.
 * The SAME set feeds the .ics file and, later, the Google provider, so both egress exactly what is previewed.
 */
export function computeDesiredEvents(
	items: TimelineItem[],
	exclusions: TaskExclusions,
	todayIso: string
): DesiredEvent[] {
	const excludedIds = new Set(exclusions.taskIds);
	const excludedCats = new Set(exclusions.categories);
	const out: DesiredEvent[] = [];
	const add = (it: TimelineItem, moment: EventMoment, isoDate: string, alarms: number[]) => {
		if (isoDate < todayIso) return;
		const alarmDays = alarms.filter((days) => addDays(isoDate, -days) > todayIso);
		out.push({
			taskId: it.def.id,
			moment,
			title: PREFIX[moment] + it.def.title,
			isoDate,
			alarmDays
		});
	};
	for (const it of items) {
		if (it.status === 'done' || it.status === 'skipped') continue;
		if (excludedIds.has(it.def.id) || excludedCats.has(it.def.category)) continue;
		// A task that cannot fit before the user leaves the command gets one reminder, on the last day there.
		if (it.status === 'after-you-leave') {
			add(
				it,
				'leave',
				it.windowEndDate,
				it.def.kind === 'soft' ? SOFT_ALARM_DAYS : FIRM_ALARM_DAYS
			);
			continue;
		}
		if (it.def.kind === 'soft') {
			const aim =
				it.status === 'snoozed' && it.snoozeUntil !== undefined ? it.snoozeUntil : it.aimDate;
			if (aim !== undefined) add(it, 'aim', aim, SOFT_ALARM_DAYS);
			continue;
		}
		if (it.windowStartDate > todayIso) add(it, 'opens', it.windowStartDate, []);
		if (it.finalEndDate !== undefined) {
			add(it, 'changes', it.windowEndDate, FIRM_ALARM_DAYS);
			add(it, 'last', it.finalEndDate, FIRM_ALARM_DAYS);
		} else {
			add(it, 'last', it.windowEndDate, FIRM_ALARM_DAYS);
		}
	}
	return out;
}
