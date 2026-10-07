import { planWrite, SKILLBRIDGE_PLAN_KEY, type PlanAnswer } from './skillbridge-plan';

/** The store calls an answer needs; the timeline store matches this shape. */
export type PlanStore = {
	setStatus(taskId: string, status: 'done' | 'skipped' | 'snoozed'): Promise<void>;
	setSnooze(taskId: string, untilIso: string): Promise<void>;
	refresh(): Promise<void>;
};

/**
 * Saves an answer tapped today. On any failure it re-reads the store (refresh, never load: a save must not reopen a
 * store the user locked) before rethrowing, so the screen shows what is really saved.
 */
export async function savePlanAnswer(
	store: PlanStore,
	answer: PlanAnswer,
	separation: string,
	todayIso: string
): Promise<void> {
	const write = planWrite(answer, separation, todayIso);
	try {
		if ('snoozeUntil' in write) await store.setSnooze(SKILLBRIDGE_PLAN_KEY, write.snoozeUntil);
		else await store.setStatus(SKILLBRIDGE_PLAN_KEY, write.status);
	} catch (err) {
		await store.refresh();
		throw err;
	}
}
