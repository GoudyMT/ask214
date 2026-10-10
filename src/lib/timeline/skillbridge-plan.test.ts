import { describe, it, expect } from 'vitest';
import {
	readPlan,
	planWrite,
	readablePlan,
	SKILLBRIDGE_PLAN_KEY,
	ASK_AGAIN_DAYS,
	LAST_ASK_DAYS
} from './skillbridge-plan';
import { addDays } from './day-math';
import type { TimelineTaskState } from './types';

// Separation Jun 30, 2028: the second ask is 456 days before (Apr 1, 2027) and the last ask 21 days before
// (Jun 9, 2028).
const SEP = '2028-06-30';
const AGAIN = '2027-04-01';
const LAST = '2028-06-09';
const read = (stored: TimelineTaskState | undefined, today: string, sep = SEP) =>
	readPlan(stored, sep, today);

describe('the SkillBridge answer', () => {
	it('derives the second ask and the last ask from the separation date', () => {
		expect(addDays(SEP, -ASK_AGAIN_DAYS)).toBe(AGAIN);
		expect(addDays(SEP, -LAST_ASK_DAYS)).toBe(LAST);
		expect(SKILLBRIDGE_PLAN_KEY).toBe('skillbridge-plan');
	});

	it('asks in the first wording before the second ask, the steps hidden', () => {
		expect(read(undefined, '2027-03-31')).toEqual({
			answer: 'none',
			card: 'first',
			stepsShow: false,
			notSureReturns: AGAIN,
			returnsOn: null
		});
	});

	it('asks a first-time visitor in the first wording at any date it may still ask', () => {
		expect(read(undefined, AGAIN)).toMatchObject({ card: 'first', notSureReturns: null });
		expect(read(undefined, '2028-06-08')).toMatchObject({ card: 'first' });
	});

	it('asks in the second wording only after an early Not sure has come back', () => {
		const early: TimelineTaskState = { status: 'snoozed', snoozeUntil: AGAIN };
		expect(read(early, AGAIN)).toMatchObject({ answer: 'not-sure', card: 'again' });
		expect(read(early, '2028-06-08')).toMatchObject({ answer: 'not-sure', card: 'again' });
		expect(read(early, LAST)).toMatchObject({ answer: 'not-sure', card: null });
	});

	it('stops asking from 21 days before separation', () => {
		expect(read(undefined, LAST)).toMatchObject({ card: null, stepsShow: false });
		expect(read({ status: 'snoozed', snoozeUntil: AGAIN }, LAST)).toMatchObject({
			card: null,
			stepsShow: false
		});
	});

	it('shows the steps after Yes and hides them after No, with no card', () => {
		expect(read({ status: 'done' }, '2026-10-07')).toMatchObject({
			answer: 'yes',
			card: null,
			stepsShow: true,
			notSureReturns: AGAIN
		});
		expect(read({ status: 'skipped' }, '2026-10-07')).toMatchObject({
			answer: 'no',
			card: null,
			stepsShow: false,
			notSureReturns: AGAIN
		});
	});

	it('keeps an early Not sure quiet until its return date, then asks again', () => {
		const early: TimelineTaskState = { status: 'snoozed', snoozeUntil: AGAIN };
		expect(read(early, '2027-03-31')).toMatchObject({
			answer: 'not-sure',
			card: null,
			stepsShow: false,
			returnsOn: AGAIN
		});
		expect(read(early, AGAIN)).toMatchObject({
			answer: 'not-sure',
			card: 'again',
			stepsShow: false,
			returnsOn: null
		});
	});

	it('brings an early Not sure back by the second ask of a separation date moved earlier', () => {
		// Saved for Jun 30, 2028; separation moved to Dec 31, 2027, whose second ask is Oct 1, 2026.
		const early: TimelineTaskState = { status: 'snoozed', snoozeUntil: AGAIN };
		expect(read(early, '2026-11-15', '2027-12-31')).toMatchObject({
			card: 'again',
			returnsOn: null
		});
		expect(read(early, '2026-09-30', '2027-12-31')).toMatchObject({
			card: null,
			returnsOn: '2026-10-01'
		});
		expect(read(early, '2026-10-01', '2027-12-31')).toMatchObject({ card: 'again' });
	});

	it('keeps the saved return date when the separation date moved later', () => {
		const early: TimelineTaskState = { status: 'snoozed', snoozeUntil: AGAIN };
		expect(read(early, '2027-03-31', '2028-12-31')).toMatchObject({ card: null, returnsOn: AGAIN });
		expect(read(early, AGAIN, '2028-12-31')).toMatchObject({ card: 'again' });
	});

	it('reads a Not sure with no date as showing the steps', () => {
		expect(read({ status: 'snoozed' }, '2027-06-01')).toMatchObject({
			answer: 'not-sure',
			card: null,
			stepsShow: true,
			notSureReturns: null
		});
	});

	it('reads every shape it never writes as no answer', () => {
		const odd = [
			{ status: 'skipped', snoozeUntil: AGAIN },
			{ status: 'snoozed', snoozeUntil: '2026-13-40' },
			{ status: 'snoozed', snoozeUntil: '2027-02-30' },
			{ status: 'snoozed', snoozeUntil: '2027-4-1' },
			{ status: 'snoozed', snoozeUntil: '2027-04-01T00:00:00Z' },
			{ status: 'snoozed', snoozeUntil: 20270401 },
			{ snoozeUntil: AGAIN },
			{ notes: 'x' },
			{ status: 'bogus' },
			{},
			null,
			'yes'
		] as unknown as TimelineTaskState[];
		for (const s of odd) {
			expect(read(s, '2027-03-31'), JSON.stringify(s)).toMatchObject({
				answer: 'none',
				card: 'first',
				stepsShow: false
			});
		}
	});

	// A note on the answer's key is the user's own text; it never hides the answer.
	it('reads the answer through a note kept with it', () => {
		const notes = 'x';
		expect(read({ status: 'done', notes }, '2026-10-07')).toMatchObject({
			answer: 'yes',
			stepsShow: true
		});
		expect(read({ status: 'skipped', notes }, '2026-10-07')).toMatchObject({ answer: 'no' });
		expect(read({ status: 'snoozed', notes }, '2027-06-01')).toMatchObject({
			answer: 'not-sure',
			stepsShow: true
		});
		expect(read({ status: 'snoozed', snoozeUntil: AGAIN, notes }, '2027-03-31')).toMatchObject({
			answer: 'not-sure',
			stepsShow: false,
			returnsOn: AGAIN
		});
	});

	// A field a newer release added to the task is kept by the store's writes and is not part of the answer.
	it('reads the answer through a field it does not know', () => {
		const pinned = { pinned: true };
		expect(read({ status: 'done', ...pinned }, '2026-10-07')).toMatchObject({ answer: 'yes' });
		expect(read({ status: 'skipped', ...pinned }, '2026-10-07')).toMatchObject({ answer: 'no' });
		expect(read({ status: 'snoozed', ...pinned }, '2027-06-01')).toMatchObject({
			answer: 'not-sure',
			stepsShow: true
		});
		expect(
			read({ status: 'snoozed', snoozeUntil: AGAIN, pinned: 1 } as TimelineTaskState, '2027-03-31')
		).toMatchObject({ answer: 'not-sure', stepsShow: false, returnsOn: AGAIN });
	});

	it('still reads a combination it never writes as no answer when an unknown field comes with it', () => {
		const odd = [
			{ status: 'skipped', snoozeUntil: AGAIN, pinned: true },
			{ status: 'snoozed', snoozeUntil: '2027-02-30', pinned: true },
			{ pinned: true }
		] as unknown as TimelineTaskState[];
		for (const s of odd) {
			expect(read(s, '2027-03-31'), JSON.stringify(s)).toMatchObject({ answer: 'none' });
		}
	});

	it('writes Yes as done, No as skipped, and Not sure by the second ask', () => {
		expect(planWrite('yes', SEP, '2026-10-07')).toEqual({ status: 'done' });
		expect(planWrite('no', SEP, '2026-10-07')).toEqual({ status: 'skipped' });
		expect(planWrite('not-sure', SEP, '2027-03-31')).toEqual({ snoozeUntil: AGAIN });
		expect(planWrite('not-sure', SEP, AGAIN)).toEqual({ status: 'snoozed' });
		expect(planWrite('not-sure', SEP, '2027-04-02')).toEqual({ status: 'snoozed' });
	});

	it('reads the answer only from a store that is ready, not failed and not locked', () => {
		const state = {
			schemaVersion: 1 as const,
			tasks: { [SKILLBRIDGE_PLAN_KEY]: { status: 'done' as const } }
		};
		const store = { ready: true, failed: false, locked: false, state };
		expect(readablePlan(store, SEP, '2026-10-07')?.answer).toBe('yes');
		expect(readablePlan({ ...store, ready: false }, SEP, '2026-10-07')).toBeNull();
		expect(readablePlan({ ...store, failed: true }, SEP, '2026-10-07')).toBeNull();
		expect(readablePlan({ ...store, locked: true }, SEP, '2026-10-07')).toBeNull();
		expect(readablePlan(null, SEP, '2026-10-07')).toBeNull();
		expect(readablePlan(store, null, '2026-10-07')).toBeNull();
	});
});
