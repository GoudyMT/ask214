import type { DesiredEvent, HandedOverEvent } from './types';

/** One identity for "the same event": its task, moment, date and title. */
function key(e: { taskId: string; moment: string; isoDate: string; title: string }): string {
	return `${e.taskId}|${e.moment}|${e.isoDate}|${e.title}`;
}

/**
 * Add the events just handed over to the record. An older version of an event stays: some calendar apps keep the
 * old date on a re-add, so it may still be in the user's calendar. Entries dated before today are history and go.
 */
export function mergeHandedOver(
	record: HandedOverEvent[] | undefined,
	events: DesiredEvent[],
	addedOn: string,
	todayIso: string
): HandedOverEvent[] {
	const kept = (record ?? []).filter((e) => e.isoDate >= todayIso);
	const seen = new Set(kept.map(key));
	const added = events
		.filter((e) => !seen.has(key(e)))
		.map((e) => ({
			taskId: e.taskId,
			moment: e.moment,
			title: e.title,
			isoDate: e.isoDate,
			addedOn
		}));
	return [...kept, ...added];
}

/**
 * The handed-over events the user should delete: dated after today, and no longer in the file as they are. "After
 * today" keeps an opening day or a snooze's last day from showing a false entry.
 */
export function staleEvents(
	record: HandedOverEvent[] | undefined,
	desired: DesiredEvent[],
	todayIso: string
): HandedOverEvent[] {
	if (!record) return [];
	const current = new Set(desired.map(key));
	return record.filter((e) => e.isoDate > todayIso && !current.has(key(e)));
}

/** The record without the entries the user said they deleted. */
export function acknowledge(
	record: HandedOverEvent[],
	listed: HandedOverEvent[]
): HandedOverEvent[] {
	const gone = new Set(listed.map(key));
	return record.filter((e) => !gone.has(key(e)));
}
