import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { withStores } from '../db/schema';
import {
	readTries,
	runPinCheck,
	type PinCheckResult,
	type TriesState
} from '../keystore/app-lock-store';
import { waitLine } from './pin-lines';
import { createCountdown } from './wait-countdown';

// Captured before any test fakes the timers: the waits on the store must stay real.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const real = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, what: string, ms = 2_000): Promise<void> {
	for (let waited = 0; !(await check()); waited += 20) {
		if (waited >= ms) expect(false, `never came: ${what}`).toBe(true);
		await real(20);
	}
}

// A document that says only what the countdown asks of it: whether the page is shown, and when that changes.
class FakeDoc extends EventTarget {
	visibilityState: 'visible' | 'hidden' = 'visible';
	listeners = 0;
	override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
		this.listeners += 1;
		super.addEventListener(...args);
	}
	override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
		this.listeners -= 1;
		super.removeEventListener(...args);
	}
	show(state: 'visible' | 'hidden'): void {
		this.visibilityState = state;
		this.dispatchEvent(new Event('visibilitychange'));
	}
}

const OWED: TriesState = { count: 4, waitMs: 30_000, pending: false };

let db: IDBDatabase;
let perf: number;
let date: number;
let doc: FakeDoc;
let lines: (string | null)[];

const putTries = (tries: TriesState) =>
	withStores(db, 'app-lock', 'readwrite', (tx) => {
		tx.objectStore('app-lock').put({ id: 'tries', ...tries });
	});
const stored = async () => (await readTries(db)).waitMs;

/** Time passing in a page that is shown: both clocks and the timers move together. */
function pass(ms: number): void {
	perf += ms;
	date += ms;
	vi.advanceTimersByTime(ms);
}

function counting(over: { dateNow?: () => number } = {}) {
	return createCountdown(
		db,
		{
			clock: { perfNow: () => perf },
			dateNow: () => date,
			doc: doc as unknown as Document,
			...over
		},
		(line) => lines.push(line)
	);
}

beforeEach(async () => {
	db = await openTestDb();
	await putTries(OWED);
	perf = 1_000;
	date = 1_700_000_000_000;
	doc = new FakeDoc();
	lines = [];
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
	vi.useRealTimers();
	await deleteTestDb(db);
});

describe('the live line', () => {
	it('says the wait at once, then each second as it changes, and not more often', async () => {
		const count = counting();
		count.start(OWED);
		expect(lines).toEqual([waitLine(30_000)]);

		pass(500);
		expect(lines).toEqual([waitLine(30_000)]);
		pass(500);
		expect(lines).toEqual([waitLine(30_000), waitLine(29_000)]);
		pass(1_000);
		expect(lines.at(-1)).toBe(waitLine(28_000));
		expect(lines).toHaveLength(3);
		expect(count.remainingMs()).toBe(28_000);
		count.stop();
	});

	it('reads in minutes above a minute, as the wait is told everywhere', async () => {
		const count = counting();
		count.start({ count: 4, waitMs: 90_000, pending: false });
		expect(lines).toEqual([waitLine(90_000)]);
		expect(lines[0]).toContain('2 minutes');

		pass(30_000);
		expect(lines.at(-1)).toContain('1 minute.');
		pass(30_000);
		expect(lines.at(-1)).toBe(waitLine(30_000));
		count.stop();
	});

	it('takes the line away at zero, and the stored wait goes to zero with it', async () => {
		const count = counting();
		count.start(OWED);

		pass(30_000);
		expect(lines.at(-1)).toBeNull();
		expect(count.remainingMs()).toBe(0);
		await until(async () => (await stored()) === 0, 'the stored wait at zero');
		const said = lines.length;
		pass(10_000);
		expect(lines).toHaveLength(said);
		count.stop();
	});

	it('is not running before a start and after a stop, and a stop says nothing', async () => {
		const count = counting();
		expect(count.remainingMs()).toBe(0);
		count.start(OWED);
		expect(count.remainingMs()).toBe(30_000);

		count.stop();
		const said = lines.length;
		pass(10_000);
		expect(count.remainingMs()).toBe(0);
		expect(lines).toHaveLength(said);
		expect(await stored()).toBe(30_000);
	});

	it('a new wait starts its own count', async () => {
		const count = counting();
		count.start(OWED);
		pass(10_000);
		count.start({ count: 4, waitMs: 60_000, pending: false });

		expect(lines.at(-1)).toBe(waitLine(60_000));
		expect(count.remainingMs()).toBe(60_000);
		count.stop();
	});

	it('says nothing for a start with no wait', async () => {
		const count = counting();
		count.start({ count: 0, waitMs: 0, pending: false });

		expect(lines).toEqual([]);
		expect(count.remainingMs()).toBe(0);
	});
});

// A good unlock clears the row, and the same count comes back after four new wrong tries: a countdown still parked in a
// tab from the first wait must not end the second one.
describe('a wait that is not the one the countdown counts', () => {
	const wrongTry = () =>
		runPinCheck(db, async (): Promise<PinCheckResult<number>> => ({ kind: 'wrong' }));
	const rightPin = () =>
		runPinCheck(db, async (): Promise<PinCheckResult<number>> => ({ kind: 'good', value: 1 }));

	/** Four wrong tries in a row: the fourth owes 30 s, as a person guessing would earn it. */
	async function fourWrongTries(): Promise<void> {
		await putTries({ count: 0, waitMs: 0, pending: false });
		for (let n = 0; n < 4; n++) await wrongTry();
		expect(await readTries(db)).toEqual(OWED);
	}

	it('lowers the wait it started with, which carries an id of its own', async () => {
		await fourWrongTries();
		const count = counting();
		count.start(OWED);
		pass(5_000);

		await until(async () => (await stored()) === 25_000, 'the remainder written');
		count.stop();
	});

	it('leaves a later wait at the same try count alone when it returns after the first wait was cleared', async () => {
		await fourWrongTries();
		const count = counting();
		count.start(OWED);
		pass(28_000);
		doc.show('hidden');

		// The first wait ends in another tab and the owner unlocks; then four new wrong tries owe a second wait.
		await fourWrongTries();
		expect(await rightPin()).toMatchObject({ kind: 'waiting' });

		perf += 3_000;
		date += 3_000;
		doc.show('visible');
		pass(5_000);

		expect(await stored()).toBeGreaterThanOrEqual(25_000);
		expect(await rightPin()).toMatchObject({ kind: 'waiting' });
		count.stop();
	});
});

describe('while the page is hidden', () => {
	// Both clocks agree: the time away is time the wait ran.
	it('counts the time away when the performance and Date clocks moved together', async () => {
		const count = counting();
		count.start(OWED);
		doc.show('hidden');
		perf += 10_000;
		date += 10_000;
		doc.show('visible');

		expect(lines.at(-1)).toBe(waitLine(20_000));
		expect(count.remainingMs()).toBe(20_000);
		pass(5_000);
		// The stored wait is lowered to what was counted and never raised above it.
		await until(async () => (await stored()) === 15_000, 'the remainder written');
		count.stop();
	});

	it('writes nothing while it is hidden', async () => {
		const count = counting();
		count.start(OWED);
		pass(2_000);
		doc.show('hidden');
		perf += 20_000;
		date += 20_000;
		vi.advanceTimersByTime(20_000);
		await real(100);

		expect(await stored()).toBe(30_000);
		expect(count.remainingMs()).toBe(28_000);
		count.stop();
	});

	// The Date clock moved far more than the performance clock: the clock was set forward, so the time away is not known.
	it('does not count the time away when the Date clock moved far more than the performance clock', async () => {
		const count = counting();
		count.start(OWED);
		doc.show('hidden');
		perf += 10_000;
		date += 100_000;
		doc.show('visible');

		expect(count.remainingMs()).toBe(30_000);
		expect(lines).toEqual([waitLine(30_000)]);
		count.stop();
	});

	// A Date clock set back would make the time away look shorter, and a page cannot tell which clock is right.
	it('does not count the time away when the Date clock went back', async () => {
		const count = counting();
		count.start(OWED);
		doc.show('hidden');
		perf += 10_000;
		date -= 50_000;
		doc.show('visible');

		expect(count.remainingMs()).toBe(30_000);
		expect(lines).toEqual([waitLine(30_000)]);
		count.stop();
	});

	// The two clocks differ by less than a second, but the Date clock went back: it was set, so the time away is unknown.
	it('does not count the time away when the Date clock went back by less than a second', async () => {
		const count = counting();
		count.start(OWED);
		doc.show('hidden');
		perf += 500;
		date -= 400;
		doc.show('visible');

		expect(count.remainingMs()).toBe(30_000);
		count.stop();
	});

	it('counts the time away when the two clocks differ by no more than a second', async () => {
		const count = counting();
		count.start(OWED);
		doc.show('hidden');
		perf += 10_000;
		date += 11_000;
		doc.show('visible');

		expect(count.remainingMs()).toBe(20_000);
		doc.show('hidden');
		perf += 10_000;
		date += 11_001;
		doc.show('visible');
		expect(count.remainingMs()).toBe(20_000);
		count.stop();
	});

	it('goes on from what is left after it, and the line goes if the time away covered the wait', async () => {
		const count = counting();
		count.start(OWED);
		doc.show('hidden');
		perf += 40_000;
		date += 40_000;
		doc.show('visible');

		expect(lines.at(-1)).toBeNull();
		expect(count.remainingMs()).toBe(0);
		// The wait is over, so the stored wait is brought down to zero too.
		pass(5_000);
		await until(async () => (await stored()) === 0, 'the stored wait at zero');
		count.stop();
	});

	// A wait that begins in a hidden page (a wrong try that resolves after a switch away, a card opened in a background tab)
	// is held to the same rule: nothing is written, and the time away counts only when the two clocks agree.
	it('begun while hidden, writes nothing and says the wait, then counts the time away when the clocks agree', async () => {
		doc.visibilityState = 'hidden';
		const count = counting();
		count.start(OWED);
		perf += 10_000;
		date += 10_000;
		vi.advanceTimersByTime(10_000);
		await real(100);

		expect(lines).toEqual([waitLine(30_000)]);
		expect(await stored()).toBe(30_000);
		expect(count.remainingMs()).toBe(30_000);

		doc.show('visible');
		expect(lines.at(-1)).toBe(waitLine(20_000));
		expect(count.remainingMs()).toBe(20_000);
		count.stop();
	});

	it('begun while hidden, does not count a time away the Date clock disagrees with', async () => {
		doc.visibilityState = 'hidden';
		const count = counting();
		count.start(OWED);
		perf += 10_000;
		date += 100_000;
		doc.show('visible');

		expect(count.remainingMs()).toBe(30_000);
		expect(lines).toEqual([waitLine(30_000)]);
		pass(5_000);
		await until(async () => (await stored()) === 25_000, 'the remainder written');
		count.stop();
	});

	// The stored wait is what a press is judged by: it has to be right the moment the page is back, not five seconds later.
	describe('on the return', () => {
		it('writes the remainder at once, and zero when the time away covered the wait', async () => {
			const count = counting();
			count.start(OWED);
			doc.show('hidden');
			perf += 40_000;
			date += 40_000;
			doc.show('visible');

			// No timer has run: a read made now queues behind the write the return opened.
			expect(await stored()).toBe(0);
			count.stop();
		});

		it('writes what is left at once when the time away covered part of the wait', async () => {
			const count = counting();
			count.start(OWED);
			doc.show('hidden');
			perf += 10_000;
			date += 10_000;
			doc.show('visible');

			const left = await stored();
			expect(left).toBeLessThanOrEqual(20_000);
			expect(left).toBeGreaterThan(19_000);
			count.stop();
		});

		// The caller of a press opens its transaction after the return opened its own, and overlapping readwrite
		// transactions run in the order they were created, so the press finds the lowered wait.
		it('lets a press made right after the return through, with no timer run', async () => {
			const count = counting();
			count.start(OWED);
			doc.show('hidden');
			perf += 40_000;
			date += 40_000;
			doc.show('visible');

			const check = vi.fn(async (): Promise<PinCheckResult<number>> => ({
				kind: 'good',
				value: 1
			}));
			const outcome = await runPinCheck(db, check);
			expect(outcome.kind).toBe('good');
			expect(check).toHaveBeenCalledOnce();
			count.stop();
		});

		it('writes nothing lower than the remainder at hide when the two clocks disagree', async () => {
			const count = counting();
			count.start(OWED);
			pass(2_000);
			doc.show('hidden');
			perf += 10_000;
			date += 100_000;
			doc.show('visible');

			expect(await stored()).toBeGreaterThanOrEqual(28_000);
			expect(count.remainingMs()).toBe(28_000);
			count.stop();
		});
	});

	it('stops listening when it is stopped', async () => {
		const count = counting();
		count.start(OWED);
		expect(doc.listeners).toBe(1);
		count.stop();

		expect(doc.listeners).toBe(0);
	});
});
