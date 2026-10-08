import { planWrite, SKILLBRIDGE_PLAN_KEY, type PlanAnswer } from './skillbridge-plan';

/** The store calls an answer needs; the timeline store matches this shape. */
export type PlanStore = {
	setStatus(taskId: string, status: 'done' | 'skipped' | 'snoozed'): Promise<void>;
	setSnooze(taskId: string, untilIso: string): Promise<void>;
	refresh(): Promise<void>;
};

/**
 * Saves an answer tapped today. On any failure it re-reads the store (refresh, never load: a save must not reopen a
 * store the user locked) before rethrowing, so the screen shows what is really saved. Resolves to the day a Not sure
 * brings the question back, as written, or null when the write brings no day: the screen words its message from the
 * write that was made, not from a clock read at another moment.
 */
export async function savePlanAnswer(
	store: PlanStore,
	answer: PlanAnswer,
	separation: string,
	todayIso: string
): Promise<string | null> {
	const write = planWrite(answer, separation, todayIso);
	try {
		if ('snoozeUntil' in write) {
			await store.setSnooze(SKILLBRIDGE_PLAN_KEY, write.snoozeUntil);
			return write.snoozeUntil;
		}
		await store.setStatus(SKILLBRIDGE_PLAN_KEY, write.status);
		return null;
	} catch (err) {
		await store.refresh();
		throw err;
	}
}
