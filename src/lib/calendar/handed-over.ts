import type { DesiredEvent, HandedOverEvent } from './types';

/** One identity for "the same event": its task, moment, date and title. */
export function handedOverKey(e: {
	taskId: string;
	moment: string;
	isoDate: string;
	title: string;
}): string {
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
	const seen = new Set(kept.map(handedOverKey));
	const added = events
		.filter((e) => !seen.has(handedOverKey(e)))
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
	const current = new Set(desired.map(handedOverKey));
	return record.filter((e) => e.isoDate > todayIso && !current.has(handedOverKey(e)));
}

/**
 * The events in the file whose step and moment were never handed over: a step added since the last add, or a new
 * moment of one. A moved or retitled event is not here: the user deletes the old one and adds again.
 */
export function missingEvents(
	record: HandedOverEvent[] | undefined,
	desired: DesiredEvent[]
): DesiredEvent[] {
	if (!record) return [];
	const held = new Set(record.map((e) => `${e.taskId}|${e.moment}`));
	return desired.filter((e) => !held.has(`${e.taskId}|${e.moment}`));
}

/** The record without the entries the user said they deleted. */
export function acknowledge(
	record: HandedOverEvent[],
	listed: HandedOverEvent[]
): HandedOverEvent[] {
	const gone = new Set(listed.map(handedOverKey));
	return record.filter((e) => !gone.has(handedOverKey(e)));
}
