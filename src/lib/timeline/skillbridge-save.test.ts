import { describe, it, expect } from 'vitest';
import { savePlanAnswer, type PlanStore } from './skillbridge-save';
import { SKILLBRIDGE_PLAN_KEY } from './skillbridge-plan';

// Separation Jun 30, 2028: the second ask is Apr 1, 2027.
const SEP = '2028-06-30';
const AGAIN = '2027-04-01';
const BEFORE = '2027-03-31';

/** A store that records its calls; `fail` makes the first write reject. */
function fakeStore(fail?: Error) {
	const calls: unknown[][] = [];
	const store: PlanStore = {
		setStatus: (id, status) => {
			calls.push(['setStatus', id, status]);
			return fail ? Promise.reject(fail) : Promise.resolve();
		},
		setSnooze: (id, until) => {
			calls.push(['setSnooze', id, until]);
			return fail ? Promise.reject(fail) : Promise.resolve();
		},
		refresh: () => {
			calls.push(['refresh']);
			return Promise.resolve();
		}
	};
	return { store, calls };
}

describe('savePlanAnswer', () => {
	it('writes Yes as done and resolves to no return day', async () => {
		const { store, calls } = fakeStore();
		await expect(savePlanAnswer(store, 'yes', SEP, BEFORE)).resolves.toBeNull();
		expect(calls).toEqual([['setStatus', SKILLBRIDGE_PLAN_KEY, 'done']]);
	});

	it('writes No as skipped and resolves to no return day', async () => {
		const { store, calls } = fakeStore();
		await expect(savePlanAnswer(store, 'no', SEP, BEFORE)).resolves.toBeNull();
		expect(calls).toEqual([['setStatus', SKILLBRIDGE_PLAN_KEY, 'skipped']]);
	});

	it('writes a Not sure before the second ask as a snooze to the second ask, and resolves to that day', async () => {
		const { store, calls } = fakeStore();
		await expect(savePlanAnswer(store, 'not-sure', SEP, BEFORE)).resolves.toBe(AGAIN);
		expect(calls).toEqual([['setSnooze', SKILLBRIDGE_PLAN_KEY, AGAIN]]);
	});

	it('writes a Not sure from the second ask on as a bare snoozed status and resolves to no return day', async () => {
		const { store, calls } = fakeStore();
		await expect(savePlanAnswer(store, 'not-sure', SEP, AGAIN)).resolves.toBeNull();
		expect(calls).toEqual([['setStatus', SKILLBRIDGE_PLAN_KEY, 'snoozed']]);
	});

	it('does not re-read the store after a save that worked', async () => {
		const { store, calls } = fakeStore();
		await savePlanAnswer(store, 'yes', SEP, BEFORE);
		expect(calls.filter((c) => c[0] === 'refresh')).toEqual([]);
	});

	it.each([
		['yes', BEFORE],
		['not-sure', BEFORE]
	] as const)(
		're-reads the store once and rethrows the same error when a %s write fails',
		async (answer, today) => {
			const boom = new Error('E_TEST_WRITE');
			const { store, calls } = fakeStore(boom);
			await expect(savePlanAnswer(store, answer, SEP, today)).rejects.toBe(boom);
			expect(calls.filter((c) => c[0] === 'refresh')).toEqual([['refresh']]);
			expect(calls[calls.length - 1]).toEqual(['refresh']);
		}
	);
});
