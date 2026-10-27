import { createWaitClock, readTriesWithId, type TriesState } from '../keystore/app-lock-store';
import { safeLog } from '../log/safelog';
import { waitLine } from './pin-lines';

// The performance and Date clocks "agree" over a stretch away when they moved the same, give or take this much.
const CLOCKS_AGREE_MS = 1_000;
const TICK_MS = 1_000;

export type CountdownDeps = {
	clock?: Parameters<typeof createWaitClock>[2] | undefined;
	dateNow?: (() => number) | undefined;
	doc?: Document | undefined;
};

/**
 * For a caller that shows the line in a message of its own: the message follows each new line only while it is still
 * the line the count last gave, so a line that replaced it (another failure) is never written over.
 */
export function followWait(
	read: () => string | null,
	write: (line: string | null) => void
): (line: string | null) => void {
	let own: string | null = null;
	return (line) => {
		if (own !== null && read() === own) write(line);
		own = line;
	};
}

/**
 * The wait line on screen, counted down by the shipped wait clock (which also writes the remainder to the tries row).
 * `onLine` hears the new text each time it changes, and null when the wait is over. While the page is hidden nothing is
 * written; on its return the time away counts only when the performance and Date clocks agree on how long it was, since a
 * Date set forward would otherwise end a wait early. Otherwise the wait goes on from where it was.
 */
export function createCountdown(
	db: IDBDatabase,
	deps: CountdownDeps,
	onLine: (line: string | null) => void
): { start(from: TriesState): void; remainingMs(): number; stop(): void } {
	const perfNow = deps.clock?.perfNow ?? (() => performance.now());
	const dateNow = deps.dateNow ?? (() => Date.now());
	let doc: Document | undefined;
	let tries = 0;
	// The id of the stored wait this countdown counts, learned once at its start. Until that read is in (or for good, if
	// the row had already moved to another try) it is the id of the wait counted before, which matches no newer wait.
	let waitId = 0;
	let clock: ReturnType<typeof createWaitClock> | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let shown: string | null = null;
	let over = false;
	let away: { left: number; perf: number; date: number } | null = null;

	function say(text: string | null): void {
		if (text === shown) return;
		shown = text;
		onLine(text);
	}

	function park(): void {
		clearTimeout(timer);
		timer = undefined;
		clock?.stop();
		clock = null;
	}

	// Looks again each second: the text is read from the remainder, so a late look shows the right time. The end is
	// written as the line goes: the timed writes fall every 5 s from the clock's start, not on the end, and a press is
	// judged by the stored wait.
	function tick(): void {
		const left = clock?.remainingMs() ?? 0;
		if (left <= 0) {
			clock?.writeNow();
			over = true;
			say(null);
			return;
		}
		say(waitLine(Math.ceil(left)));
		timer = setTimeout(tick, TICK_MS);
	}

	function run(waitMs: number, onReturn: boolean): void {
		over = false;
		clock = createWaitClock(
			db,
			{ count: tries, waitMs, pending: false },
			{ ...deps.clock, waitId: () => waitId }
		);
		// A page that comes back writes what is left (zero for a wait that ran out while it was away) before anything else
		// can open a transaction: a press is judged by the stored wait, and it must not find the wait from before the
		// absence. IndexedDB runs overlapping readwrite transactions in the order they were created, and this one is
		// created here, inside the visibility event, so any press that follows opens its transaction after this write.
		if (onReturn) clock.writeNow();
		// A wait of zero reads as over at once: the line goes.
		tick();
	}

	function onVisibility(): void {
		if (doc?.visibilityState === 'hidden') {
			if (clock === null || over || away !== null) return;
			away = { left: clock.remainingMs(), perf: perfNow(), date: dateNow() };
			park();
			return;
		}
		if (away === null) return;
		const was = away;
		away = null;
		const byPerf = perfNow() - was.perf;
		const byDate = dateNow() - was.date;
		const agree = byPerf >= 0 && byDate >= 0 && Math.abs(byPerf - byDate) <= CLOCKS_AGREE_MS;
		run(agree ? was.left - byPerf : was.left, true);
	}

	function stop(): void {
		park();
		doc?.removeEventListener('visibilitychange', onVisibility);
		doc = undefined;
		away = null;
		over = false;
		shown = null;
	}

	return {
		start(from) {
			stop();
			if (from.waitMs <= 0) return;
			tries = from.count;
			// Opened before the first clock exists, so the read is ordered ahead of every write that clock makes. A read
			// that lands late can only carry the id of its own count, and a restart at another count has its own read.
			readTriesWithId(db).then(
				(row) => {
					if (row.count === tries) waitId = row.waitId;
				},
				() => safeLog({ code: 'E_INTERNAL' })
			);
			doc = deps.doc ?? document;
			doc.addEventListener('visibilitychange', onVisibility);
			// Begun in a hidden page: no clock yet, so nothing is written and the first return applies the clocks rule.
			if (doc.visibilityState !== 'hidden') run(from.waitMs, false);
			else {
				away = { left: from.waitMs, perf: perfNow(), date: dateNow() };
				say(waitLine(Math.ceil(from.waitMs)));
			}
		},
		remainingMs: () => (away ? away.left : over || clock === null ? 0 : clock.remainingMs()),
		stop
	};
}

type Shared = {
	db: IDBDatabase;
	count: ReturnType<typeof createCountdown>;
	followers: Set<(line: string | null) => void>;
	line: string | null;
};
let shared: Shared | null = null;

/**
 * The tab's one count of the owed wait, for the screens that show it (the Unlock card, the forms that check the current
 * PIN). A screen follows it and leaves it: leaving only stops that screen hearing the line, since the wait is owed whether
 * or not a screen is up, and a count that stopped with its screen would let the wait pass unwritten. It is made on first use
 * for a database handle (a new handle, after a restore or in a test, gets its own, and the old one ends). A follower is
 * handed the current line at once, if a wait is counting.
 */
export function followCountdown(
	db: IDBDatabase,
	deps: CountdownDeps,
	onLine: (line: string | null) => void
): { start(from: TriesState): void; remainingMs(): number; unfollow(): void } {
	if (shared?.db !== db) {
		shared?.count.stop();
		const made: Shared = {
			db,
			followers: new Set(),
			line: null,
			count: createCountdown(db, deps, (line) => {
				made.line = line;
				for (const follower of made.followers) follower(line);
			})
		};
		shared = made;
	}
	const { count, followers, line } = shared;
	followers.add(onLine);
	if (line !== null) onLine(line);
	return {
		start: count.start,
		remainingMs: count.remainingMs,
		unfollow: () => followers.delete(onLine)
	};
}

/** A good check reset the row: the count ends, and a screen that follows later is told nothing. */
export function endCountdown(db: IDBDatabase): void {
	if (shared?.db !== db) return;
	shared.count.stop();
	shared.line = null;
}
