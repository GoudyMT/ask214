import { addDays } from './day-math';
import type { TimelineState, TimelineTaskState } from './types';

/**
 * The SkillBridge question's answer and what it means for the Timeline. It is kept in the timeline state under a key
 * no task uses, in the shapes the store already writes: Yes = { status: 'done' }; No = { status: 'skipped' }; Not
 * sure before the second ask = { status: 'snoozed', snoozeUntil }; Not sure from the second ask on = { status:
 * 'snoozed' } with no date, which shows the steps. Any other shape reads as no answer, so a damaged record asks again
 * and never shows steps nobody chose.
 */
export const SKILLBRIDGE_PLAN_KEY = 'skillbridge-plan';

/** About 15 months before separation: a month before the search for a program should start. */
export const ASK_AGAIN_DAYS = 456;

/** From 3 weeks before separation a request can no longer be submitted "at least 3 weeks prior to start". */
export const LAST_ASK_DAYS = 21;

export type PlanAnswer = 'yes' | 'not-sure' | 'no';

export type PlanRead = {
	answer: PlanAnswer | 'none';
	/** The question card to show, by its wording, or null for none. */
	card: 'first' | 'again' | null;
	stepsShow: boolean;
	/** The day a Not sure tapped today brings the card back; null when a Not sure today shows the steps. */
	notSureReturns: string | null;
	/** While a saved Not sure keeps the card away, the day it comes back. */
	returnsOn: string | null;
};

/** A write through the timeline store: `status` -> setStatus, `snoozeUntil` -> setSnooze. */
export type PlanWrite = { status: 'done' | 'skipped' | 'snoozed' } | { snoozeUntil: string };

/** A calendar day that survives a UTC round trip unchanged: only YYYY-MM-DD comes back equal, and 2026-02-30 does not. */
function isDay(v: unknown): v is string {
	if (typeof v !== 'string') return false;
	const t = new Date(`${v}T00:00:00Z`);
	return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}

type Saved =
	| { kind: 'none' }
	| { kind: 'yes' }
	| { kind: 'no' }
	| { kind: 'early'; until: string }
	| { kind: 'late' };

// The stored value comes from disk, so it can be anything: null or a non-object reads as no answer.
function recognise(raw: unknown): Saved {
	if (typeof raw !== 'object' || raw === null) return { kind: 'none' };
	const s = raw as TimelineTaskState;
	const keys = Object.entries(s)
		.filter(([, v]) => v !== undefined)
		.map(([k]) => k)
		.sort()
		.join(',');
	if (keys === 'status' && s.status === 'done') return { kind: 'yes' };
	if (keys === 'status' && s.status === 'skipped') return { kind: 'no' };
	if (keys === 'status' && s.status === 'snoozed') return { kind: 'late' };
	if (keys === 'snoozeUntil,status' && s.status === 'snoozed' && isDay(s.snoozeUntil)) {
		return { kind: 'early', until: s.snoozeUntil };
	}
	return { kind: 'none' };
}

/** What the saved answer means today, for a separation date (ISO) and today's local date (ISO). */
export function readPlan(
	stored: TimelineTaskState | undefined,
	separation: string,
	todayIso: string
): PlanRead {
	const again = addDays(separation, -ASK_AGAIN_DAYS);
	const canAsk = todayIso < addDays(separation, -LAST_ASK_DAYS);
	const notSureReturns = todayIso < again ? again : null;
	const asking = (answer: PlanRead['answer']): PlanRead => ({
		answer,
		card: canAsk ? (todayIso < again ? 'first' : 'again') : null,
		stepsShow: false,
		notSureReturns,
		returnsOn: null
	});
	const saved = recognise(stored);
	switch (saved.kind) {
		case 'yes':
			return { answer: 'yes', card: null, stepsShow: true, notSureReturns, returnsOn: null };
		case 'no':
			return { answer: 'no', card: null, stepsShow: false, notSureReturns, returnsOn: null };
		case 'late':
			return { answer: 'not-sure', card: null, stepsShow: true, notSureReturns, returnsOn: null };
		case 'early': {
			// Judged against the current separation date too, so moving it earlier never hides the card past its time.
			const back = saved.until < again ? saved.until : again;
			if (todayIso < back) {
				return {
					answer: 'not-sure',
					card: null,
					stepsShow: false,
					notSureReturns,
					returnsOn: back
				};
			}
			return { ...asking('not-sure'), card: canAsk ? 'again' : null };
		}
		default:
			return asking('none');
	}
}

/** The store write for an answer tapped today. */
export function planWrite(answer: PlanAnswer, separation: string, todayIso: string): PlanWrite {
	if (answer === 'yes') return { status: 'done' };
	if (answer === 'no') return { status: 'skipped' };
	const again = addDays(separation, -ASK_AGAIN_DAYS);
	return todayIso < again ? { snoozeUntil: again } : { status: 'snoozed' };
}

/** The timeline store's parts the answer needs; the store itself matches this shape. */
export type ReadableStore = {
	ready: boolean;
	failed: boolean;
	locked: boolean;
	state: TimelineState;
};

/**
 * The answer, or null while it cannot be known: the store still loading, locked, or failed to load. Null means show
 * nothing and offer no change - an empty stand-in state would read as "no answer" and ask someone who already did.
 */
export function readablePlan(
	store: ReadableStore | null | undefined,
	separation: string | null,
	todayIso: string
): PlanRead | null {
	if (!store || !separation || !store.ready || store.failed || store.locked) return null;
	return readPlan(store.state.tasks[SKILLBRIDGE_PLAN_KEY], separation, todayIso);
}
