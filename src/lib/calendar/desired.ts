import type { TimelineItem } from '../timeline/generate';
import type { TaskExclusions, DesiredEvent } from './types';

/**
 * Project generated timeline items into the shared desired-event set: one all-day event per
 * PENDING (not done/skipped), NON-EXCLUDED task. A snoozed task stays pending with its event at
 * the snooze date; every other pending status uses the target date. Pure + deterministic. The
 * SAME set feeds the .ics file and, later, the Google provider, so both egress exactly what the
 * consent preview shows.
 */
export function computeDesiredEvents(
	items: TimelineItem[],
	exclusions: TaskExclusions
): DesiredEvent[] {
	const excludedIds = new Set(exclusions.taskIds);
	const excludedCats = new Set(exclusions.categories);
	const out: DesiredEvent[] = [];
	for (const it of items) {
		if (it.status === 'done' || it.status === 'skipped') continue;
		if (excludedIds.has(it.def.id) || excludedCats.has(it.def.category)) continue;
		const isoDate =
			it.status === 'snoozed' && it.snoozeUntil !== undefined ? it.snoozeUntil : it.targetDate;
		out.push({ taskId: it.def.id, title: it.def.title, isoDate });
	}
	return out;
}
