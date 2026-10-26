import { createWaitClock, type TriesState } from '../keystore/app-lock-store';
import { waitLine } from './pin-lines';

// The performance and Date clocks "agree" over a stretch away when they moved the same, give or take this much.
const CLOCKS_AGREE_MS = 1_000;
const TICK_MS = 1_000;

export type CountdownDeps = {
	clock?: Parameters<typeof createWaitClock>[2] | undefined;
	dateNow?: (() => number) | undefined;
	setTimeout?: typeof setTimeout | undefined;
	clearTimeout?: typeof clearTimeout | undefined;
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
		(deps.clearTimeout ?? clearTimeout)(timer);
		timer = undefined;
		clock?.stop();
		clock = null;
	}

	// Looks again when the text next changes, at least once a second.
	function tick(): void {
		const left = clock?.remainingMs() ?? 0;
		if (left <= 0) {
			over = true;
			say(null);
			return;
		}
		say(waitLine(Math.ceil(left)));
		const untilChange = left - (Math.ceil(left / TICK_MS) - 1) * TICK_MS;
		timer = (deps.setTimeout ?? setTimeout)(tick, Math.min(TICK_MS, untilChange));
	}

	function run(waitMs: number): void {
		over = false;
		// A wait already over still gets a clock, so the row's stored wait is brought down to zero within seconds.
		clock = createWaitClock(
			db,
			{ count: tries, waitMs: Math.max(waitMs, 1), pending: false },
			deps.clock
		);
		if (waitMs > 0) tick();
		else {
			over = true;
			say(null);
		}
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
		run(agree ? Math.max(0, was.left - byPerf) : was.left);
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
			doc = deps.doc ?? document;
			doc.addEventListener('visibilitychange', onVisibility);
			run(from.waitMs);
		},
		remainingMs: () => (away ? away.left : over || clock === null ? 0 : clock.remainingMs()),
		stop
	};
}
