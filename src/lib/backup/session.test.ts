import { describe, expect, it, vi } from 'vitest';
import { RunAbortedError } from '../db/locks';
import { createJoinRelock, relockEachSync } from '../profile/app-init';
import type { Relockable } from '../profile/app-init';
import { IDLE_THRESHOLD_MS } from '../profile/idle-threshold';
import type { RelockReason } from '../profile/lifecycle';
import { KDF_WORKER_SRC } from './kdf-paths';
import type { BackupCode } from './codes';
import {
	BACKUP_DEADLINE_MS,
	BackupSession,
	mapWorkerLoadFailure,
	untilAborted,
	type OpenPicker,
	type Phase,
	type Run,
	type SessionDeps,
	type SessionKind,
	type StartApp,
	type WorkerLike
} from './session.svelte';
import type { WorkerRequest } from './worker/protocol';

// ---- fakes -------------------------------------------------------------------------------------------------------

const WORDS_A = ['alpha', 'bravo', 'cobalt', 'delta', 'ember', 'flint'];
const WORDS_B = ['gamma', 'harbor', 'island', 'jungle', 'kernel', 'lantern'];
const MINUTE = 60_000;

/** Two independent clocks (wall and monotonic) and one timer queue that only `advance` runs. */
class FakeClock {
	wall = Date.UTC(2026, 9, 15, 18, 0, 0);
	mono = 10_000;
	#timerNow = 0;
	#next = 1;
	#timers: { id: number; at: number; fn: () => void }[] = [];

	setTimer = (fn: () => void, ms: number): unknown => {
		const id = this.#next++;
		this.#timers.push({ id, at: this.#timerNow + ms, fn });
		return id;
	};
	clearTimer = (id: unknown): void => {
		this.#timers = this.#timers.filter((t) => t.id !== id);
	};
	get pending(): number {
		return this.#timers.length;
	}
	/** Moves both clocks and fires the timers that come due on the way, in order. */
	advance(ms: number): void {
		const target = this.#timerNow + ms;
		for (;;) {
			const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			this.#timers = this.#timers.filter((t) => t.id !== due.id);
			this.#timerNow = due.at;
			due.fn();
		}
		this.#timerNow = target;
		this.wall += ms;
		this.mono += ms;
	}
}

class FakeWorker implements WorkerLike {
	posted: { message: WorkerRequest; transfer: Transferable[] }[] = [];
	terminated = 0;
	terminateThrows = false;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessageerror: ((event: unknown) => void) | null = null;

	postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
		// A real transfer: the sender's buffer is detached the moment it is posted.
		if (transfer.length > 0) structuredClone(message, { transfer });
		this.posted.push({ message, transfer });
	}
	terminate(): void {
		this.terminated++;
		if (this.terminateThrows) throw new Error('terminate');
	}
	answer(data: unknown): void {
		this.onmessage?.({ data });
	}
	fail(): void {
		this.onerror?.({});
	}
}

class FakeInput {
	type = '';
	files: File[] | null = null;
	clicked = 0;
	removed = false;
	accept: string | undefined = undefined;
	#listeners: Record<string, (() => void)[]> = {};
	addEventListener(type: string, fn: () => void): void {
		(this.#listeners[type] ??= []).push(fn);
	}
	click(): void {
		this.clicked++;
	}
	remove(): void {
		this.removed = true;
	}
	fire(type: 'change' | 'cancel'): void {
		for (const fn of this.#listeners[type] ?? []) fn();
	}
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
} {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function nth<T>(items: T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error('E_TEST_MISSING_ITEM');
	return item;
}

function makeApp(over: Partial<StartApp> = {}): {
	app: StartApp;
	joined: Relockable[];
	leave: ReturnType<typeof vi.fn>;
} {
	const joined: Relockable[] = [];
	const leave = vi.fn();
	const app: StartApp = {
		status: 'ready',
		joinRelock: (r) => {
			joined.push(r);
			return leave;
		},
		publish: () => {},
		...over
	};
	return { app, joined, leave };
}

function harness(over: Partial<SessionDeps> = {}) {
	const clock = new FakeClock();
	const win = new EventTarget();
	const added: string[] = [];
	const removed: string[] = [];
	const realAdd = win.addEventListener.bind(win);
	const realRemove = win.removeEventListener.bind(win);
	win.addEventListener = (
		type: string,
		...rest: [EventListenerOrEventListenerObject | null, ...unknown[]]
	) => {
		added.push(type);
		realAdd(type, ...(rest as [EventListenerOrEventListenerObject | null]));
	};
	win.removeEventListener = (
		type: string,
		...rest: [EventListenerOrEventListenerObject | null, ...unknown[]]
	) => {
		removed.push(type);
		realRemove(type, ...(rest as [EventListenerOrEventListenerObject | null]));
	};
	const workers: FakeWorker[] = [];
	const inputs: FakeInput[] = [];
	const env = {
		visible: true,
		focus: true,
		probe: 'E_WORKER_FAILED' as BackupCode,
		picker: null as OpenPicker | null
	};
	const flush = vi.fn((fn: () => void) => fn());
	const probeWorker = vi.fn(async () => env.probe);
	const s = new BackupSession({
		now: () => clock.wall,
		mono: () => clock.mono,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		getWindow: () => win,
		isVisible: () => env.visible,
		hasFocus: () => env.focus,
		createWorker: () => {
			const w = new FakeWorker();
			workers.push(w);
			return w;
		},
		probeWorker,
		createInput: () => {
			const input = new FakeInput();
			inputs.push(input);
			return input;
		},
		getOpenPicker: () => env.picker,
		flush,
		...over
	});
	const { app, joined, leave } = makeApp();
	return {
		s,
		clock,
		win,
		added,
		removed,
		workers,
		inputs,
		env,
		flush,
		probeWorker,
		app,
		joined,
		leave
	};
}

type H = ReturnType<typeof harness>;

/** An export session that has shown its words, parked in `typed-back`, holding a save handle. */
async function exportWithWords(h: H, words = WORDS_A): Promise<void> {
	h.s.start(h.app, 'export');
	const shown = h.s.showPassphrase();
	nth(h.workers, h.workers.length - 1).answer({ type: 'words', words });
	await shown;
	h.s.enterPhase('typed-back');
}

function startRestore(h: H, kind: 'restore' | 'check' = 'restore'): void {
	h.s.start(h.app, kind);
	h.s.enterPhase('file-chosen');
}

/** Lets every pending promise continuation run; the fake clock is separate, so a real timer is safe here. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const FRESH_SALT = (): Uint8Array<ArrayBuffer> => new Uint8Array(16);
const passBuffer = (): ArrayBuffer => new Uint8Array([97, 108, 112]).buffer;

// ---- start, the run API and busy ---------------------------------------------------------------------------------

describe('start and the single operation', () => {
	// The Settings rows and the wizard row are inert until this holds, so a row can never run without relock coverage.
	it.each<[string, Partial<StartApp>, SessionKind, boolean]>([
		['export on a ready app', {}, 'export', true],
		['restore on a ready app', {}, 'restore', true],
		['check on a ready app', {}, 'check', true],
		['check on a damaged app', { status: 'damaged', publish: null }, 'check', true],
		['export on a damaged app', { status: 'damaged', publish: null }, 'export', false],
		['restore on a damaged app', { status: 'damaged', publish: null }, 'restore', false],
		['restore with no publish seam', { publish: null }, 'restore', false],
		['export with no relock set', { joinRelock: null }, 'export', false],
		['check while the app is still loading', { status: 'loading' }, 'check', false]
	])('start: %s', (_name, over, kind, allowed) => {
		const h = harness();
		const { app } = makeApp(over);
		if (allowed) {
			h.s.start(app, kind);
			expect(h.s.kind).toBe(kind);
			expect(h.s.active).toBe(true);
		} else {
			expect(() => h.s.start(app, kind)).toThrow('E_BACKUP_UNAVAILABLE');
			expect(h.s.active).toBe(false);
		}
	});

	// Make, Restore and Check share one session, so a second row cannot start under a running one.
	it('a second start while a session is open throws and joins nothing', () => {
		const h = harness();
		h.s.start(h.app, 'export');
		expect(() => h.s.start(h.app, 'restore')).toThrow('E_BACKUP_UNAVAILABLE');
		expect(h.joined).toHaveLength(1);
		expect(h.s.kind).toBe('export');
	});

	it('the session joins the relock set on start and leaves it, with its pagehide listener, on end', () => {
		const h = harness();
		h.s.start(h.app, 'export');
		expect(h.joined).toHaveLength(1);
		expect(h.added).toContain('pagehide');
		h.s.end();
		expect(h.leave).toHaveBeenCalledTimes(1);
		expect(h.removed).toContain('pagehide');
		expect(h.s.phase).toBe('idle');
		// A pagehide after the end must not touch the next session.
		h.s.start(h.app, 'check');
		h.s.end();
		expect(h.leave).toHaveBeenCalledTimes(2);
	});

	// A held Enter or a double click must start exactly one operation: busy is taken before any await.
	it('beginRun takes busy synchronously, so a second handler gets nothing', () => {
		const h = harness();
		h.s.start(h.app, 'check');
		const first = h.s.beginRun();
		expect(first).not.toBeNull();
		expect(h.s.busy).toBe(true);
		expect(h.s.beginRun()).toBeNull();
		first?.release();
		expect(h.s.busy).toBe(false);
		expect(h.s.beginRun()).not.toBeNull();
	});

	it('the session adds no blur or visibilitychange listener and a focus listener only while it waits', async () => {
		const h = harness();
		await exportWithWords(h);
		h.env.focus = false;
		const run = h.s.beginRun() as Run;
		const derived = h.s.derive(run, { purpose: 'export', pass: passBuffer(), salt: FRESH_SALT() });
		expect(h.added.filter((t) => t === 'focus')).toHaveLength(1);
		h.env.focus = true;
		h.win.dispatchEvent(new Event('focus'));
		await tick();
		nth(h.workers, 1).answer({ type: 'progress', percent: 1 });
		h.s.relockSync('hygiene');
		await expect(derived).rejects.toBeInstanceOf(RunAbortedError);
		expect(h.removed).toContain('focus');
		expect(new Set(h.added)).toEqual(new Set(['pagehide', 'focus']));
	});
});

// ---- the run API through a fake flow ---------------------------------------------------------------------------

describe('runs', () => {
	// The abort is a bump then an abort, in that order, so anything woken by the abort already sees a stale run id.
	it('abortRun bumps the run id before it aborts the signal', () => {
		const h = harness();
		h.s.start(h.app, 'check');
		const run = h.s.beginRun() as Run;
		let seen = -1;
		run.signal.addEventListener('abort', () => {
			seen = h.s.runId;
		});
		h.s.abortRun('test');
		expect(seen).toBe(run.id + 1);
		expect(run.isCurrent()).toBe(false);
	});

	// A flow whose run was aborted may still be mid-await; nothing it does afterwards may reach the session.
	it('a stale run cannot enter a phase, hold, commit or release a newer run', () => {
		const h = harness();
		h.s.start(h.app, 'restore');
		const stale = h.s.beginRun() as Run;
		h.s.relockSync('user');
		h.s.start(h.app, 'restore');
		h.s.enterPhase('file-chosen');
		const fresh = h.s.beginRun() as Run;
		const buffer = new Uint8Array([1, 2, 3]);
		const record = { bytes: new Uint8Array([4, 5]) };
		expect(stale.enter('decrypting')).toBe(false);
		expect(stale.hold('key', {})).toBe(false);
		expect(stale.toPre('E_WORKER_FAILED')).toBe(false);
		expect(stale.mayCommit()).toBe(false);
		expect(stale.own(buffer)).toBe(false);
		expect(stale.ownRecord(record)).toBe(false);
		stale.release();
		expect(h.s.phase).toBe('file-chosen');
		expect(h.s.held('key')).toBeNull();
		expect(h.s.busy).toBe(true);
		expect(fresh.isCurrent()).toBe(true);
		// What a stale run produced is zeroed on the spot, because nothing will ever own it.
		expect([...buffer]).toEqual([0, 0, 0]);
		expect([...record.bytes]).toEqual([0, 0]);
	});

	// A step that is awaited to its end (a decrypt under a lock) settles after the abort; its product must be zeroed.
	it('plaintext produced after an abort is zeroed and a current run keeps what it owns', () => {
		const h = harness();
		h.s.start(h.app, 'restore');
		h.s.enterPhase('file-chosen');
		const run = h.s.beginRun() as Run;
		run.enter('decrypting');
		const plain = new Uint8Array([9, 9, 9]);
		const record = { field: new Uint8Array([8, 8]) };
		expect(run.own(plain)).toBe(true);
		expect(run.ownRecord(record)).toBe(true);
		expect([...plain]).toEqual([9, 9, 9]);
		h.s.relockSync('hygiene');
		expect([...plain]).toEqual([0, 0, 0]);
		expect([...record.field]).toEqual([0, 0]);
		const late = new Uint8Array([7]);
		expect(run.own(late)).toBe(false);
		expect([...late]).toEqual([0]);
	});

	// Nothing in a run is raced except the awaits that may never settle; those must settle the moment the run aborts.
	it('untilAborted settles on abort for a promise that never settles, and passes real results through', async () => {
		const ctl = new AbortController();
		const hung = untilAborted(new Promise<never>(() => {}), ctl.signal);
		ctl.abort();
		await expect(hung).rejects.toBeInstanceOf(RunAbortedError);
		await expect(untilAborted(Promise.resolve(5), new AbortController().signal)).resolves.toBe(5);
		const failing = Promise.reject(new Error('picker'));
		await expect(untilAborted(failing, new AbortController().signal)).rejects.toThrow('picker');
		await expect(untilAborted(Promise.resolve(1), ctl.signal)).rejects.toBeInstanceOf(
			RunAbortedError
		);
	});
});

// ---- the relock table --------------------------------------------------------------------------------------------

const EXPORT_PRE: Phase[] = [
	'phrase-hidden',
	'phrase-shown',
	'typed-back',
	'picking-save',
	'save-chosen',
	'replace-warning'
];
const RESTORE_PRE: Phase[] = ['getting-ready', 'choose-file', 'file-chosen'];

/** A session parked in `phase`, holding what that phase holds, ready for a relock. */
async function park(h: H, kind: SessionKind, phase: Phase) {
	const file = new Uint8Array([1, 2, 3]);
	const handle = { name: 'handle' };
	if (kind === 'export') {
		if (phase === 'phrase-hidden') h.s.start(h.app, 'export');
		else await exportWithWords(h);
	} else {
		h.s.start(h.app, kind);
		h.s.enterPhase('file-chosen');
	}
	const holder = h.s.beginRun() as Run;
	if (kind === 'export') holder.hold('saveHandle', handle);
	else {
		holder.hold('fileBytes', file);
		holder.hold('parsed', { v: 1 });
	}
	holder.release();
	if (phase !== 'phrase-hidden') h.s.enterPhase(phase);
	return { file, handle };
}

const KEY_ROWS: [SessionKind, Phase, Phase][] = [
	['export', 'deriving', 'typed-back'],
	['export', 'snapshot', 'typed-back'],
	['export', 'encrypting', 'typed-back'],
	['export', 'verifying', 'typed-back'],
	['export', 'writing', 'typed-back'],
	['restore', 'deriving', 'file-chosen'],
	['restore', 'decrypting', 'file-chosen'],
	['restore', 'confirm', 'file-chosen'],
	['restore', 'writing', 'file-chosen']
];

/** A session inside a KEY phase with everything a flow could hold there, plus the spies that prove it dropped. */
async function parkInKey(h: H, kind: SessionKind, phase: Phase) {
	await park(h, kind, kind === 'export' ? 'typed-back' : 'file-chosen');
	const run = h.s.beginRun() as Run;
	const owned = new Uint8Array([5, 5, 5]);
	const record = { field: new Uint8Array([6, 6]) };
	const writableAbort = vi.fn();
	const closeConfirm = vi.fn();
	h.s.registerConfirm(closeConfirm);
	let derived: Promise<unknown> | null = null;
	if (phase === 'deriving') {
		derived = h.s.derive(run, {
			purpose: kind === 'export' ? 'export' : 'restore',
			pass: passBuffer(),
			salt: FRESH_SALT()
		});
		derived.catch(() => {});
	} else {
		run.enter(phase);
	}
	run.hold('key', { key: true });
	run.hold('envelope', { env: true });
	run.hold('confirm', { summary: true });
	run.hold('writable', { abort: writableAbort });
	run.own(owned);
	run.ownRecord(record);
	return { run, owned, record, writableAbort, closeConfirm, derived };
}

describe('hygiene relock (an app switch)', () => {
	// The person switched to a password manager and back: nothing they hold may be dropped, only hidden.
	it.each([
		...EXPORT_PRE.map((p): [SessionKind, Phase] => ['export', p]),
		...RESTORE_PRE.map((p): [SessionKind, Phase] => ['restore', p])
	])(
		'in %s %s keeps the words, the handle and the file bytes and only conceals',
		async (kind, phase) => {
			const h = harness();
			const held = await park(h, kind, phase);
			const wordsBefore = h.s.words;
			const run = h.s.beginRun() as Run;
			h.s.relockSync('hygiene');
			expect(h.s.phase).toBe(phase);
			expect(h.s.concealed).toBe(true);
			expect(run.signal.aborted).toBe(false);
			expect(h.s.words).toBe(wordsBefore);
			if (kind === 'export') expect(h.s.held('saveHandle')).toBe(held.handle);
			else expect(h.s.held('fileBytes')).toBe(held.file);
			expect(h.s.message).toBeNull();
			expect(h.s.active).toBe(true);
		}
	);

	// A hide in the middle of machine work cannot be finished safely, so it stops, drops every key and returns.
	it.each(KEY_ROWS)(
		'in %s %s stops the run, drops the key work and returns to the last input',
		async (kind, phase, back) => {
			const h = harness();
			const held = await parkInKey(h, kind, phase);
			const wordsBefore = h.s.words;
			const fileBefore = h.s.held('fileBytes');
			h.s.relockSync('hygiene');
			expect(held.run.signal.aborted).toBe(true);
			expect(h.s.phase).toBe(back);
			expect(h.s.message).toBe('E_LEFT_APP');
			expect(h.s.busy).toBe(false);
			expect(h.s.concealed).toBe(true);
			expect(h.s.held('key')).toBeNull();
			expect(h.s.held('envelope')).toBeNull();
			expect(h.s.held('confirm')).toBeNull();
			expect(h.s.held('writable')).toBeNull();
			expect(h.s.held('saveHandle')).toBeNull();
			expect([...held.owned]).toEqual([0, 0, 0]);
			expect([...held.record.field]).toEqual([0, 0]);
			expect(held.writableAbort).toHaveBeenCalledTimes(1);
			expect(held.closeConfirm).toHaveBeenCalledTimes(1);
			expect(h.s.words).toBe(wordsBefore);
			expect(h.s.held('fileBytes')).toBe(fileBefore);
			if (phase === 'deriving') expect(nth(h.workers, h.workers.length - 1).terminated).toBe(1);
			expect(h.clock.pending).toBe(0);
		}
	);

	it('in generating terminates the worker and returns to phrase-hidden', async () => {
		const h = harness();
		h.s.start(h.app, 'export');
		const shown = h.s.showPassphrase();
		h.s.relockSync('hygiene');
		await shown;
		expect(nth(h.workers, 0).terminated).toBe(1);
		expect(h.s.phase).toBe('phrase-hidden');
		expect(h.s.words).toBeNull();
		expect(h.s.busy).toBe(false);
		expect(h.s.concealed).toBe(true);
	});

	// A second hygiene during one absence must not move the clock the away-time check reads.
	it('a second hygiene during one absence does not restamp the time away', async () => {
		const h = harness();
		await exportWithWords(h);
		h.s.relockSync('hygiene');
		h.clock.advance(14 * MINUTE);
		h.s.relockSync('hygiene');
		h.clock.advance(2 * MINUTE);
		await h.s.refresh();
		// 16 minutes since the first hide: cleared. A restamp at minute 14 would read only 2 minutes and un-conceal.
		expect(h.s.phase).toBe('idle');
		expect(h.s.words).toBeNull();
	});
});

describe('clearing relocks', () => {
	const REASONS: [RelockReason, { peerReason?: 'idle' | 'user' } | undefined][] = [
		['idle', undefined],
		['user', undefined],
		['peer', undefined],
		['peer', { peerReason: 'user' }]
	];
	const SITES: [SessionKind, Phase][] = [
		['export', 'phrase-shown'],
		['export', 'typed-back'],
		['restore', 'file-chosen'],
		['export', 'deriving'],
		['restore', 'confirm']
	];

	// A real lock, an idle lapse or a peer's Lock: the secret is gone, the session is over, and the person is told why.
	it.each(
		REASONS.flatMap(([reason, detail]) =>
			SITES.map(([kind, phase]) => [reason, detail, kind, phase] as const)
		)
	)('%s %j clears an open %s session in %s', async (reason, detail, kind, phase) => {
		const h = harness();
		const input = { value: 'typed words' };
		if (phase === 'deriving' || phase === 'confirm') await parkInKey(h, kind, phase);
		else await park(h, kind, phase);
		h.s.registerInput(input);
		h.s.relockSync(reason, detail);
		expect(h.s.phase).toBe('idle');
		expect(h.s.active).toBe(false);
		expect(h.s.words).toBeNull();
		expect(h.s.revealed).toBe(false);
		expect(h.s.held('fileBytes')).toBeNull();
		expect(h.s.held('saveHandle')).toBeNull();
		expect(h.s.backupAt).toBeNull();
		expect(input.value).toBe('');
		expect(h.s.message).toBe('E_LOCKED');
		expect(h.s.busy).toBe(false);
		expect(h.leave).toHaveBeenCalledTimes(1);
	});

	// The app switch must keep a typed field; only a real clear wipes it.
	it('registered inputs are scrubbed by a clear and by end, never by hygiene, and unregister', async () => {
		const h = harness();
		await exportWithWords(h);
		const kept = { value: 'one' };
		const gone = { value: 'two' };
		h.s.registerInput(kept);
		const unregister = h.s.registerInput(gone);
		h.s.relockSync('hygiene');
		expect(kept.value).toBe('one');
		unregister();
		h.s.end();
		expect(kept.value).toBe('');
		expect(gone.value).toBe('two');
	});

	// Another tab idling is not this person leaving: a session still being typed into must not lose its words.
	it('a peer idle lock leaves a PRE session alone: no clear, no conceal, no message', async () => {
		const h = harness();
		await exportWithWords(h);
		const words = h.s.words;
		h.s.relockSync('peer', { peerReason: 'idle' });
		expect(h.s.phase).toBe('typed-back');
		expect(h.s.words).toBe(words);
		expect(h.s.concealed).toBe(false);
		expect(h.s.message).toBeNull();
		expect(h.flush).not.toHaveBeenCalled();
		expect(h.leave).not.toHaveBeenCalled();
	});

	it('a peer idle lock stops key work and keeps the words', async () => {
		const h = harness();
		const held = await parkInKey(h, 'export', 'snapshot');
		const words = h.s.words;
		h.s.relockSync('peer', { peerReason: 'idle' });
		expect(held.run.signal.aborted).toBe(true);
		expect(h.s.phase).toBe('typed-back');
		expect(h.s.words).toBe(words);
		expect(h.s.words).not.toBeNull();
		expect(h.s.message).toBe('E_LOCKED');
		expect(h.s.held('key')).toBeNull();
		expect(h.s.active).toBe(true);
	});

	// The page is leaving (maybe into the back-forward cache): words must not ride along, but a committed write is past.
	it('pagehide clears a PRE session, stops and clears a KEY one, and only records in COMMIT', async () => {
		const pre = harness();
		await exportWithWords(pre);
		pre.win.dispatchEvent(new Event('pagehide'));
		expect(pre.s.phase).toBe('idle');
		expect(pre.s.words).toBeNull();

		const key = harness();
		const held = await parkInKey(key, 'restore', 'decrypting');
		key.win.dispatchEvent(new Event('pagehide'));
		expect(held.run.signal.aborted).toBe(true);
		expect(key.s.phase).toBe('idle');
		expect(key.s.held('fileBytes')).toBeNull();

		const commit = harness();
		startRestore(commit);
		const run = commit.s.beginRun() as Run;
		run.enter('writing');
		commit.s.markCommitting();
		commit.win.dispatchEvent(new Event('pagehide'));
		expect(commit.s.phase).toBe('writing');
		expect(commit.s.epochMovedBy).toBe('pagehide');
		expect(run.signal.aborted).toBe(false);
	});
});

describe('relock while committing', () => {
	// An abort that lands half-way into a restore that has begun writing would leave the device half-replaced.
	it('does not abort, terminate, zero or clear a committing run, and records the reason', () => {
		const h = harness();
		startRestore(h);
		const run = h.s.beginRun() as Run;
		run.enter('writing');
		const owned = new Uint8Array([3, 3]);
		const closeConfirm = vi.fn();
		h.s.registerConfirm(closeConfirm);
		run.own(owned);
		run.hold('key', { key: true });
		h.s.markCommitting();
		const abort = vi.spyOn(run.signal, 'aborted', 'get');
		for (const reason of ['hygiene', 'idle', 'user', 'peer'] as const) h.s.relockSync(reason);
		abort.mockRestore();
		expect(run.signal.aborted).toBe(false);
		expect(h.s.runId).toBe(run.id);
		expect(h.s.phase).toBe('writing');
		expect([...owned]).toEqual([3, 3]);
		expect(h.s.held('key')).not.toBeNull();
		expect(closeConfirm).not.toHaveBeenCalled();
		expect(h.s.epochMovedBy).toBe('idle');
		expect(h.s.canCancel).toBe(false);
		expect(h.s.cancel()).toBe(false);
		expect(h.s.phase).toBe('writing');
	});

	// Closing the card while the writer is past its point of no return must not reach the writer's run or its session.
	it('ending the session while committing is ignored and the writer run is left alone', () => {
		const h = harness();
		startRestore(h);
		const run = h.s.beginRun() as Run;
		run.enter('writing');
		h.s.markCommitting();
		const id = h.s.runId;
		h.s.end();
		expect(run.signal.aborted).toBe(false);
		expect(h.s.runId).toBe(id);
		expect(h.s.phase).toBe('writing');
		expect(h.s.active).toBe(true);
		expect(h.leave).not.toHaveBeenCalled();
	});

	// The idle check on coming back must not clear a session whose write has begun; it only notes the reason.
	it('a refresh after a long absence only records while committing', async () => {
		const h = harness();
		startRestore(h);
		h.s.relockSync('hygiene');
		const run = h.s.beginRun() as Run;
		run.enter('writing');
		h.s.markCommitting();
		h.clock.advance(IDLE_THRESHOLD_MS);
		await h.s.refresh();
		expect(h.s.phase).toBe('writing');
		expect(run.signal.aborted).toBe(false);
		expect(h.s.epochMovedBy).toBe('idle');
		expect(h.s.concealed).toBe(false);
	});

	// A run from an earlier session must never look current to the next one.
	it('start moves the run id past every earlier run', () => {
		const h = harness();
		const before = h.s.runId;
		h.s.start(h.app, 'check');
		expect(h.s.runId).toBeGreaterThan(before);
	});

	// The export read-back must know the person left the page, so it can say "saved, but not checked".
	it('the card leaving while committing is recorded as navigation and does not cancel', () => {
		const h = harness();
		startRestore(h);
		const run = h.s.beginRun() as Run;
		run.enter('writing');
		h.s.markCommitting();
		h.s.cardGone();
		expect(h.s.epochMovedBy).toBe('navigated');
		expect(h.s.phase).toBe('writing');
		expect(run.signal.aborted).toBe(false);
		// A real lock still outranks it.
		h.s.relockSync('user');
		expect(h.s.epochMovedBy).toBe('user');
	});

	it('a hygiene alone is recorded as hygiene and never overwrites a stronger reason', () => {
		const h = harness();
		startRestore(h);
		(h.s.beginRun() as Run).enter('writing');
		h.s.markCommitting();
		h.s.relockSync('hygiene');
		expect(h.s.epochMovedBy).toBe('hygiene');
		h.s.relockSync('idle');
		h.s.relockSync('hygiene');
		expect(h.s.epochMovedBy).toBe('idle');
	});

	// After the restore the line says Unlock; a later real lock changes it, an app switch does not.
	it.each<[RelockReason, boolean]>([
		['hygiene', false],
		['idle', true],
		['user', true],
		['peer', true]
	])('after a restore, a %s relock sets lockedAfterRestore to %s', (reason, expected) => {
		const h = harness();
		startRestore(h);
		const run = h.s.beginRun() as Run;
		run.enter('writing');
		h.s.markCommitting();
		run.enter('committed');
		h.s.relockSync(reason);
		expect(h.s.lockedAfterRestore).toBe(expected);
		expect(h.s.active).toBe(true);
		expect(h.s.phase).toBe('committed');
	});

	// The export's commit point drops every secret at once; later relocks have nothing to take.
	it('entering saved drops the words, the key and the inputs and a later clear only records', async () => {
		const h = harness();
		const held = await parkInKey(h, 'export', 'writing');
		const input = { value: 'words' };
		h.s.registerInput(input);
		held.run.enter('saved');
		expect(h.s.committing).toBe(true);
		expect(h.s.words).toBeNull();
		expect(h.s.held('key')).toBeNull();
		expect([...held.owned]).toEqual([0, 0, 0]);
		expect(input.value).toBe('');
		expect(held.writableAbort).not.toHaveBeenCalled();
		// The ciphertext envelope stays: the read-back compares against it.
		expect(h.s.held('envelope')).toEqual({ env: true });
		h.s.relockSync('user');
		expect(h.s.phase).toBe('saved');
		expect(h.s.epochMovedBy).toBe('user');
		expect(held.run.signal.aborted).toBe(false);
	});

	// A Check or an export that has reached done holds nothing secret; a lock then just closes it, with no LOCKED line.
	it('entering done drops every secret and a later lock ends the session quietly', async () => {
		const h = harness();
		startRestore(h, 'check');
		const run = h.s.beginRun() as Run;
		const owned = new Uint8Array([2, 2]);
		const record = { field: new Uint8Array([3]) };
		const input = { value: 'words' };
		h.s.registerInput(input);
		run.enter('decrypting');
		run.hold('key', { key: true });
		run.hold('fileBytes', new Uint8Array([1]));
		run.own(owned);
		run.ownRecord(record);
		run.enter('done');
		expect(h.s.held('key')).toBeNull();
		expect(h.s.held('fileBytes')).toBeNull();
		expect([...owned]).toEqual([0, 0]);
		expect([...record.field]).toEqual([0]);
		expect(input.value).toBe('');
		h.s.relockSync('user');
		expect(h.s.phase).toBe('idle');
		expect(h.s.message).toBeNull();
		expect(h.leave).toHaveBeenCalledTimes(1);
		h.s.start(h.app, 'check');
		expect(h.s.active).toBe(true);
	});

	it.each(['pagehide', 'cardGone', 'end'] as const)(
		'a %s in done ends the session quietly',
		(how) => {
			const h = harness();
			h.s.start(h.app, 'export');
			const run = h.s.beginRun() as Run;
			run.enter('writing');
			run.enter('saved');
			run.enter('done');
			if (how === 'pagehide') h.win.dispatchEvent(new Event('pagehide'));
			else if (how === 'cardGone') h.s.cardGone();
			else h.s.end();
			expect(h.s.phase).toBe('idle');
			expect(h.s.message).toBeNull();
		}
	);
});

// ---- walk totality -----------------------------------------------------------------------------------------------

describe('relock walk totality', () => {
	// One step failing (a terminate that throws, a buffer that cannot be filled) must not strand plaintext in the steps
	// after it, and must never escape into the walk of the shipped stores.
	it.each(['abort', 'terminate', 'zero', 'writable', 'confirm', 'input'] as const)(
		'a throwing %s still runs every later step',
		async (thrower) => {
			const throwing = () => {
				throw new Error('step');
			};
			const controller = new AbortController();
			if (thrower === 'abort') controller.abort = throwing;
			const h = harness({ createController: () => controller });
			await park(h, 'export', 'typed-back');
			const run = h.s.beginRun() as Run;
			const derived = h.s.derive(run, {
				purpose: 'export',
				pass: passBuffer(),
				salt: FRESH_SALT()
			});
			derived.catch(() => {});
			const worker = nth(h.workers, h.workers.length - 1);
			worker.terminateThrows = thrower === 'terminate';
			const bad = { fill: throwing };
			const good = new Uint8Array([4, 4]);
			run.own(thrower === 'zero' ? bad : new Uint8Array([1]));
			run.own(good);
			const writableAbort = vi.fn(thrower === 'writable' ? throwing : () => {});
			run.hold('writable', { abort: writableAbort });
			const confirm = vi.fn(thrower === 'confirm' ? throwing : () => {});
			h.s.registerConfirm(confirm);
			const badInput = {
				set value(_v: string) {
					throw new Error('input');
				},
				get value() {
					return 'x';
				}
			};
			const goodInput = { value: 'secret' };
			if (thrower === 'input') h.s.registerInput(badInput);
			h.s.registerInput(goodInput);

			expect(() => h.s.relockSync('user')).not.toThrow();

			expect(worker.terminated).toBe(1);
			expect([...good]).toEqual([0, 0]);
			expect(writableAbort).toHaveBeenCalledTimes(1);
			expect(confirm).toHaveBeenCalledTimes(1);
			expect(goodInput.value).toBe('');
			expect(h.s.phase).toBe('idle');
			expect(h.s.words).toBeNull();
			expect(h.leave).toHaveBeenCalledTimes(1);
		}
	);

	// The session joins through the shipped wrapper and walk; the reason and the peer's reason must arrive.
	it('is reached by the shipped walk with the reason and the peer detail', async () => {
		const h = harness();
		const list: Relockable[] = [];
		const app = makeApp({ joinRelock: createJoinRelock(list) }).app;
		h.s.start(app, 'export');
		const shown = h.s.showPassphrase();
		nth(h.workers, 0).answer({ type: 'words', words: WORDS_A });
		await shown;
		h.s.enterPhase('typed-back');
		relockEachSync(list, 'peer', { peerReason: 'idle' });
		expect(h.s.phase).toBe('typed-back');
		expect(h.s.concealed).toBe(false);
		relockEachSync(list, 'hygiene');
		expect(h.s.concealed).toBe(true);
		relockEachSync(list, 'peer');
		expect(h.s.active).toBe(false);
		expect(list).toHaveLength(0);
	});

	// What the lifecycle's restore calls on the joined entry: it must be the session's own refresh.
	it('joins an entry whose refresh, through the shipped wrapper, is the time-away check', async () => {
		const h = harness();
		const list: Relockable[] = [];
		h.s.start(makeApp({ joinRelock: createJoinRelock(list) }).app, 'export');
		const shown = h.s.showPassphrase();
		nth(h.workers, 0).answer({ type: 'words', words: WORDS_A });
		await shown;
		relockEachSync(list, 'hygiene');
		h.clock.advance(IDLE_THRESHOLD_MS);
		await nth(list, 0).refresh();
		expect(h.s.phase).toBe('idle');
	});

	// The passphrase buffer is detached the moment it is posted; touching it again would throw in the middle of a walk.
	it('a relock after the passphrase buffer was transferred does not throw and still terminates', async () => {
		const h = harness();
		await park(h, 'export', 'typed-back');
		const run = h.s.beginRun() as Run;
		const pass = passBuffer();
		const derived = h.s.derive(run, { purpose: 'export', pass, salt: FRESH_SALT() });
		derived.catch(() => {});
		const worker = nth(h.workers, h.workers.length - 1);
		expect(pass.byteLength).toBe(0);
		expect(nth(worker.posted, 0).transfer).toEqual([pass]);
		expect(() => h.s.relockSync('idle')).not.toThrow();
		expect(worker.terminated).toBe(1);
		await expect(derived).rejects.toBeInstanceOf(RunAbortedError);
	});

	// Before the worker has it, the page still owns the passphrase bytes and must wipe them on a stop.
	it('a passphrase still waiting for the page to be shown is wiped when the run stops', async () => {
		const h = harness();
		await park(h, 'export', 'typed-back');
		const before = h.workers.length;
		h.env.focus = false;
		const run = h.s.beginRun() as Run;
		const pass = passBuffer();
		const derived = h.s.derive(run, { purpose: 'export', pass, salt: FRESH_SALT() });
		derived.catch(() => {});
		h.s.cancel();
		expect([...new Uint8Array(pass)]).toEqual([0, 0, 0]);
		await expect(derived).rejects.toBeInstanceOf(RunAbortedError);
		expect(h.workers).toHaveLength(before);
	});
});

// ---- conceal and the time away ----------------------------------------------------------------------------------

describe('un-conceal checks the time away', () => {
	// The idle timer cannot run in a frozen page, so the words must not come back after a long absence.
	it.each<[string, (h: H) => void]>([
		['the wall clock passed 15 minutes', (h) => (h.clock.wall += IDLE_THRESHOLD_MS)],
		['the monotonic clock passed 15 minutes', (h) => (h.clock.mono += IDLE_THRESHOLD_MS)],
		['the wall clock moved backward', (h) => (h.clock.wall -= 60_000)]
	])('clears and never re-mounts the words when %s', async (_name, move) => {
		const h = harness();
		await exportWithWords(h);
		const input = { value: 'typed' };
		h.s.registerInput(input);
		h.s.relockSync('hygiene');
		move(h);
		await h.s.refresh();
		expect(h.flush).toHaveBeenCalledTimes(1); // the conceal; there is no un-conceal call
		expect(h.s.words).toBeNull();
		expect(h.s.phase).toBe('idle');
		expect(h.s.message).toBe('E_LOCKED');
		expect(input.value).toBe('');
		expect(h.s.revealed).toBe(false);
	});

	it('brings the words back after 14 minutes, the same words', async () => {
		const h = harness();
		await exportWithWords(h);
		const words = h.s.words;
		h.s.relockSync('hygiene');
		expect(h.s.concealed).toBe(true);
		h.clock.advance(14 * MINUTE);
		await h.s.refresh();
		expect(h.s.concealed).toBe(false);
		expect(h.s.words).toBe(words);
		expect(h.s.revealed).toBe(true);
	});

	it('a resume while the page is still hidden does not un-conceal', async () => {
		const h = harness();
		await exportWithWords(h);
		h.s.relockSync('hygiene');
		h.env.visible = false;
		await h.s.refresh();
		expect(h.s.concealed).toBe(true);
		h.env.visible = true;
		await h.s.refresh();
		expect(h.s.concealed).toBe(false);
	});

	// A lifecycle restore fires on every visible event, hidden or not; with nothing concealed it must be a no-op.
	it('a refresh with nothing concealed changes nothing and never rejects', async () => {
		const h = harness();
		await expect(h.s.refresh()).resolves.toBeUndefined();
		await exportWithWords(h);
		await h.s.refresh();
		expect(h.s.phase).toBe('typed-back');
		expect(h.flush).not.toHaveBeenCalled();
	});
});

// ---- the words, the worker and the time stamp -------------------------------------------------------------------

describe('the passphrase worker', () => {
	// The generator runs once per session: a second press must show the same words, not roll new ones.
	it('Show creates one worker, terminates it after the words arrive, and a second Show reuses the words', async () => {
		const h = harness();
		h.s.start(h.app, 'export');
		const first = h.s.showPassphrase();
		expect(h.workers).toHaveLength(1);
		expect(nth(h.workers, 0).posted[0]?.message).toEqual({ op: 'generate' });
		expect(h.s.phase).toBe('generating');
		nth(h.workers, 0).answer({ type: 'words', words: WORDS_A });
		await first;
		expect(nth(h.workers, 0).terminated).toBe(1);
		expect(h.s.phase).toBe('phrase-shown');
		expect(h.s.words).toEqual(WORDS_A);
		expect(h.s.revealed).toBe(true);
		expect(h.s.busy).toBe(false);
		h.s.revealed = false;
		await h.s.showPassphrase();
		expect(h.workers).toHaveLength(1);
		expect(h.s.revealed).toBe(true);
		expect(h.s.words).toEqual(WORDS_A);
	});

	// After the commit the words are gone from memory; a Show then must not roll a second phrase for this session.
	it.each<Phase>(['saved', 'picking-save'])(
		'Show in %s makes no worker and shows nothing',
		async (phase) => {
			const h = harness();
			await exportWithWords(h);
			const run = h.s.beginRun() as Run;
			run.enter('writing');
			run.enter('saved');
			run.release();
			h.s.enterPhase(phase);
			h.s.revealed = false;
			const workers = h.workers.length;
			await h.s.showPassphrase();
			expect(h.workers).toHaveLength(workers);
			expect(h.s.revealed).toBe(false);
			expect(h.s.words).toBeNull();
		}
	);

	it('a double Show press starts one worker', async () => {
		const h = harness();
		h.s.start(h.app, 'export');
		const first = h.s.showPassphrase();
		const second = h.s.showPassphrase();
		expect(h.workers).toHaveLength(1);
		nth(h.workers, 0).answer({ type: 'words', words: WORDS_A });
		await Promise.all([first, second]);
		expect(h.s.words).toEqual(WORDS_A);
	});

	// A saved copy of the words stays valid across every abort, and only a real clear ends them.
	it('a stopped key run, a deadline and a worker failure keep the words and the time stamp', async () => {
		const h = harness();
		await exportWithWords(h);
		const at = h.s.backupAt;
		const names = h.s.names;
		for (const stop of [
			() => h.s.relockSync('hygiene'),
			() => h.clock.advance(BACKUP_DEADLINE_MS)
		]) {
			const run = h.s.beginRun() as Run;
			const derived = h.s.derive(run, {
				purpose: 'export',
				pass: passBuffer(),
				salt: FRESH_SALT()
			});
			derived.catch(() => {});
			stop();
			await expect(derived).rejects.toBeInstanceOf(RunAbortedError);
			expect(h.s.words).toEqual(WORDS_A);
			expect(h.s.backupAt).toBe(at);
			expect(h.s.names).toEqual(names);
		}
		const run = h.s.beginRun() as Run;
		const derived = h.s.derive(run, { purpose: 'export', pass: passBuffer(), salt: FRESH_SALT() });
		nth(h.workers, h.workers.length - 1).answer({ type: 'error', code: 'E_WORKER_FAILED' });
		expect(await derived).toEqual({ ok: false, code: 'E_WORKER_FAILED' });
		run.toPre('E_WORKER_FAILED');
		expect(h.s.words).toEqual(WORDS_A);
		expect(h.s.backupAt).toBe(at);
		expect(h.workers.filter((w) => w.posted[0]?.message.op === 'generate')).toHaveLength(1);
	});

	it('a new session after a user Lock shows different words and a new time stamp', async () => {
		const h = harness();
		await exportWithWords(h);
		const firstAt = h.s.backupAt;
		h.s.relockSync('user');
		h.clock.advance(MINUTE);
		await exportWithWords(h, WORDS_B);
		expect(h.s.words).toEqual(WORDS_B);
		expect(h.s.backupAt).not.toBe(firstAt);
		expect(h.workers.filter((w) => w.posted[0]?.message.op === 'generate')).toHaveLength(2);
	});

	// One timestamp feeds the label, the file name, the created date and the last-backup date.
	it('the label date and file name come from the moment the words appeared, not from later', async () => {
		const clock = new Date(2026, 9, 15, 23, 59, 59, 900).getTime();
		const h = harness();
		h.clock.wall = clock;
		await exportWithWords(h);
		expect(h.s.backupAt).toBe(clock);
		h.clock.advance(200); // past midnight
		const names = h.s.names;
		expect(names?.fileName).toMatch(/^ask214-backup-2026-10-15-[A-Z2-7]{4}\.json$/);
		expect(names?.label).toMatch(/^Ask 214 backup 2026-10-15 [A-Z2-7]{4}$/);
		expect(names?.label.slice(-4)).toBe(names?.fileName.slice(-9, -5));
	});

	// A worker that cannot load is told apart from one that fails: the cause decides what the person is asked to do.
	it.each<[string, BackupCode]>([
		['the file is there', 'E_WORKER_FAILED'],
		['the file is gone after an update', 'E_APP_UPDATED'],
		['the network is down', 'E_CODE_UNAVAILABLE']
	])('a worker that fails to load maps to the probe answer when %s', async (_name, code) => {
		const h = harness();
		h.env.probe = code;
		h.s.start(h.app, 'export');
		const shown = h.s.showPassphrase();
		nth(h.workers, 0).fail();
		await shown;
		expect(h.probeWorker).toHaveBeenCalledTimes(1);
		expect(h.s.message).toBe(code);
		expect(h.s.phase).toBe('phrase-hidden');
		expect(h.s.words).toBeNull();
		expect(h.s.busy).toBe(false);
	});

	it.each<[string, (w: FakeWorker) => void, BackupCode]>([
		['posts an error code', (w) => w.answer({ type: 'error', code: 'E_NO_MEMORY' }), 'E_NO_MEMORY'],
		[
			'posts something malformed',
			(w) => w.answer({ type: 'words', words: ['a'] }),
			'E_WORKER_FAILED'
		],
		['hits a message error', (w) => w.onmessageerror?.({}), 'E_WORKER_FAILED'],
		[
			'posts words that carry an extra field',
			(w) => w.answer({ type: 'words', words: WORDS_A, extra: 1 }),
			'E_WORKER_FAILED'
		]
	])('a worker that %s ends in its code with no words', async (_name, act, code) => {
		const h = harness();
		h.s.start(h.app, 'export');
		const shown = h.s.showPassphrase();
		act(nth(h.workers, 0));
		await shown;
		expect(h.s.message).toBe(code);
		expect(h.s.words).toBeNull();
		expect(h.probeWorker).not.toHaveBeenCalled();
	});

	it('mapWorkerLoadFailure probes the worker file with a HEAD and nothing else', async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		await expect(mapWorkerLoadFailure(fetchImpl)).resolves.toBe('E_WORKER_FAILED');
		expect(fetchImpl).toHaveBeenCalledWith(KDF_WORKER_SRC, { method: 'HEAD' });
		await expect(
			mapWorkerLoadFailure(vi.fn(async () => new Response(null, { status: 404 })))
		).resolves.toBe('E_APP_UPDATED');
		await expect(
			mapWorkerLoadFailure(
				vi.fn(async () => {
					throw new TypeError('network');
				})
			)
		).resolves.toBe('E_CODE_UNAVAILABLE');
		await expect(
			mapWorkerLoadFailure(vi.fn(async () => new Response(null, { status: 500 })))
		).resolves.toBe('E_WORKER_FAILED');
	});
});

describe('deriving', () => {
	// KEY work must not begin while the page is behind a password manager prompt, or the hide would abort a loop.
	it('waits for the page to be visible and focused before it creates the worker', async () => {
		const h = harness();
		await park(h, 'export', 'typed-back');
		const before = h.workers.length;
		h.env.focus = false;
		const run = h.s.beginRun() as Run;
		const derived = h.s.derive(run, { purpose: 'export', pass: passBuffer(), salt: FRESH_SALT() });
		await tick();
		expect(h.workers).toHaveLength(before);
		expect(h.s.phase).toBe('typed-back');
		expect(h.clock.pending).toBe(0);
		h.env.focus = true;
		h.win.dispatchEvent(new Event('focus'));
		await tick();
		expect(h.workers).toHaveLength(before + 1);
		expect(h.s.phase).toBe('deriving');
		expect(h.clock.pending).toBe(1);
		const worker = nth(h.workers, before);
		worker.answer({ type: 'progress', percent: 40 });
		expect(h.s.progress).toBe(40);
		const real = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
			'encrypt'
		]);
		worker.answer({ type: 'key', key: real });
		const result = await derived;
		expect(result).toEqual({ ok: true, key: real });
		expect(h.s.held('key')).toBe(real);
		expect(worker.terminated).toBe(1);
		expect(worker.posted[0]?.message.op).toBe('derive');
	});

	it('the page coming back visible (a lifecycle refresh) also starts the waiting derive', async () => {
		const h = harness();
		await park(h, 'export', 'typed-back');
		const before = h.workers.length;
		h.env.visible = false;
		h.env.focus = false;
		const run = h.s.beginRun() as Run;
		const derived = h.s.derive(run, { purpose: 'export', pass: passBuffer(), salt: FRESH_SALT() });
		derived.catch(() => {});
		await tick();
		expect(h.workers).toHaveLength(before);
		h.env.visible = true;
		h.env.focus = true;
		await h.s.refresh();
		await tick();
		expect(h.workers).toHaveLength(before + 1);
	});

	// WRONG_PASSPHRASE-style answers carry a position so the message can name the word, never the word.
	it('an error answer comes back as a result with its code and word position', async () => {
		const h = harness();
		startRestore(h);
		const run = h.s.beginRun() as Run;
		const derived = h.s.derive(run, { purpose: 'restore', pass: passBuffer(), salt: FRESH_SALT() });
		nth(h.workers, 0).answer({ type: 'error', code: 'E_NOT_A_WORD', position: 3 });
		expect(await derived).toEqual({ ok: false, code: 'E_NOT_A_WORD', position: 3 });
		expect(h.s.phase).toBe('deriving');
		expect(run.toPre('E_NOT_A_WORD')).toBe(true);
		expect(h.s.phase).toBe('file-chosen');
		expect(h.s.message).toBe('E_NOT_A_WORD');
	});

	it('Cancel then an immediate restart starts exactly one new worker', async () => {
		const h = harness();
		await park(h, 'export', 'typed-back');
		const run = h.s.beginRun() as Run;
		const derived = h.s.derive(run, { purpose: 'export', pass: passBuffer(), salt: FRESH_SALT() });
		derived.catch(() => {});
		h.s.relockSync('idle');
		h.s.start(h.app, 'export');
		const shown = h.s.showPassphrase();
		const generateWorkers = h.workers.filter((w) => !w.terminated);
		expect(generateWorkers).toHaveLength(1);
		expect(nth(generateWorkers, 0).posted[0]?.message.op).toBe('generate');
		h.s.cancel();
		await shown;
	});
});

// ---- cancel and busy ---------------------------------------------------------------------------------------------

describe('cancel', () => {
	// The person pressed Cancel while the phone was working: the secrets go now, the outcome waits for the work.
	it('in key work clears at once, shows Stopping, and reports only after the in-flight step settles', async () => {
		const h = harness();
		await park(h, 'export', 'typed-back');
		const run = h.s.beginRun() as Run;
		const derived = h.s.derive(run, { purpose: 'export', pass: passBuffer(), salt: FRESH_SALT() });
		derived.catch(() => {});
		expect(h.s.cancel()).toBe(true);
		expect(h.s.busy).toBe(false);
		expect(h.s.phase).toBe('idle');
		expect(h.s.words).toBeNull();
		expect(h.s.stopping).toBe(true);
		expect(h.s.message).toBeNull();
		await expect(derived).rejects.toBeInstanceOf(RunAbortedError);
		run.release();
		expect(h.s.stopping).toBe(false);
		expect(h.s.message).toBe('E_RESTORE_CANCELLED');
	});

	// A settle from the run Cancel stopped must not paint a message over the session the person started next.
	it('a late settle after a new session started reports nothing', async () => {
		const h = harness();
		await park(h, 'export', 'typed-back');
		const run = h.s.beginRun() as Run;
		h.s.enterPhase('snapshot');
		h.s.cancel();
		h.s.start(h.app, 'check');
		run.release();
		expect(h.s.stopping).toBe(false);
		expect(h.s.message).toBeNull();
	});

	it('in an input phase just ends the session, silently', async () => {
		const h = harness();
		await exportWithWords(h);
		expect(h.s.canCancel).toBe(true);
		expect(h.s.cancel()).toBe(true);
		expect(h.s.phase).toBe('idle');
		expect(h.s.stopping).toBe(false);
		expect(h.s.message).toBeNull();
		expect(h.s.words).toBeNull();
		expect(h.leave).toHaveBeenCalledTimes(1);
	});

	// Leaving Settings for another route cancels; an app switch swaps the card out and must not.
	it.each<[string, boolean, boolean, boolean]>([
		['the card is visible and shown', true, false, true],
		['the page is concealed', true, true, false],
		['the page is hidden', false, false, false]
	])('cardGone cancels only when %s', async (_name, visible, conceal, cancelled) => {
		const h = harness();
		await exportWithWords(h);
		h.env.visible = visible;
		if (conceal) h.s.relockSync('hygiene');
		h.s.cardGone();
		expect(h.s.active).toBe(!cancelled);
	});
});

// ---- the deadline ------------------------------------------------------------------------------------------------

describe('the deadline guards machine work only', () => {
	it('a silent worker in deriving hits the deadline once, with the words kept', async () => {
		const h = harness();
		await exportWithWords(h);
		const run = h.s.beginRun() as Run;
		const derived = h.s.derive(run, { purpose: 'export', pass: passBuffer(), salt: FRESH_SALT() });
		derived.catch(() => {});
		const worker = nth(h.workers, h.workers.length - 1);
		h.clock.advance(BACKUP_DEADLINE_MS - 1);
		expect(h.s.phase).toBe('deriving');
		h.clock.advance(1);
		await expect(derived).rejects.toBeInstanceOf(RunAbortedError);
		expect(h.s.phase).toBe('typed-back');
		expect(h.s.message).toBe('E_TOOK_TOO_LONG');
		expect(h.s.words).toEqual(WORDS_A);
		expect(worker.terminated).toBe(1);
		expect(h.s.busy).toBe(false);
		const id = h.s.runId;
		h.clock.advance(10 * MINUTE);
		expect(h.s.runId).toBe(id);
	});

	it('a silent generate hits the deadline and returns to phrase-hidden', async () => {
		const h = harness();
		h.s.start(h.app, 'export');
		const shown = h.s.showPassphrase();
		h.clock.advance(BACKUP_DEADLINE_MS);
		await shown;
		expect(h.s.phase).toBe('phrase-hidden');
		expect(h.s.message).toBe('E_TOOK_TOO_LONG');
		expect(nth(h.workers, 0).terminated).toBe(1);
		expect(h.s.words).toBeNull();
	});

	// The person is reading a dialog, not waiting on the phone: no clock may run while a person decides.
	it.each<[SessionKind, Phase]>([
		['export', 'phrase-shown'],
		['export', 'typed-back'],
		['export', 'picking-save'],
		['export', 'save-chosen'],
		['export', 'replace-warning'],
		['restore', 'getting-ready'],
		['restore', 'choose-file'],
		['restore', 'file-chosen']
	])('no deadline runs in %s %s', (kind, phase) => {
		const h = harness();
		h.s.start(h.app, kind);
		const run = h.s.beginRun() as Run;
		run.enter(phase);
		h.clock.advance(10 * MINUTE);
		expect(h.s.phase).toBe(phase);
		expect(run.signal.aborted).toBe(false);
		expect(h.clock.pending).toBe(0);
	});

	it('the confirm stays open ten minutes, and Replace then starts a fresh writer deadline', () => {
		const h = harness();
		startRestore(h);
		const run = h.s.beginRun() as Run;
		run.enter('decrypting');
		h.clock.advance(20_000);
		run.enter('confirm');
		h.clock.advance(10 * MINUTE);
		expect(h.s.phase).toBe('confirm');
		expect(run.signal.aborted).toBe(false);
		run.enter('writing');
		h.clock.advance(BACKUP_DEADLINE_MS - 1);
		expect(h.s.phase).toBe('writing');
		h.clock.advance(1);
		expect(h.s.phase).toBe('file-chosen');
		expect(h.s.message).toBe('E_TOOK_TOO_LONG');
		expect(run.signal.aborted).toBe(true);
	});

	it('a confirm left open ten minutes can still commit, and a commit has no deadline', () => {
		const h = harness();
		startRestore(h);
		const run = h.s.beginRun() as Run;
		run.enter('decrypting');
		run.enter('confirm');
		h.clock.advance(10 * MINUTE);
		run.enter('writing');
		expect(run.mayCommit()).toBe(true);
		h.s.markCommitting();
		h.clock.advance(10 * MINUTE);
		expect(h.s.phase).toBe('writing');
		expect(run.signal.aborted).toBe(false);
		expect(h.s.committing).toBe(true);
	});

	it('a device-moved return re-arms the decrypting span and disarms at the re-shown confirm', () => {
		const h = harness();
		startRestore(h);
		const run = h.s.beginRun() as Run;
		run.enter('decrypting');
		run.enter('confirm');
		run.enter('writing');
		h.clock.advance(50_000);
		run.enter('decrypting');
		h.clock.advance(50_000);
		expect(h.s.phase).toBe('decrypting');
		run.enter('confirm');
		h.clock.advance(10 * MINUTE);
		expect(h.s.phase).toBe('confirm');
		expect(h.clock.pending).toBe(0);
	});

	// Snapshot to close is one machine span: stepping between its phases must not give the phone a fresh minute each.
	it('the export span is one deadline across snapshot, encrypting, verifying and writing', async () => {
		const h = harness();
		await exportWithWords(h);
		const run = h.s.beginRun() as Run;
		run.enter('snapshot');
		h.clock.advance(20_000);
		run.enter('encrypting');
		h.clock.advance(20_000);
		run.enter('verifying');
		h.clock.advance(10_000);
		run.enter('writing');
		h.clock.advance(9_999);
		expect(h.s.phase).toBe('writing');
		h.clock.advance(1);
		expect(h.s.phase).toBe('typed-back');
		expect(h.s.message).toBe('E_TOOK_TOO_LONG');
	});

	it.each<Phase>(['saved', 'checking', 'done'])(
		'no deadline runs after the export commit point (%s)',
		async (phase) => {
			const h = harness();
			await exportWithWords(h);
			const run = h.s.beginRun() as Run;
			run.enter('snapshot');
			run.enter('writing');
			run.enter('saved');
			run.enter(phase);
			h.clock.advance(10 * MINUTE);
			expect(h.s.phase).toBe(phase);
			expect(run.signal.aborted).toBe(false);
			expect(h.clock.pending).toBe(0);
		}
	);
});

// ---- the file chooser --------------------------------------------------------------------------------------------

describe('the file chooser', () => {
	// The picker needs the click's activation, so it must be called before any await in the click handler.
	it('calls showOpenFilePicker synchronously with no types, and an AbortError stays in choose-file', async () => {
		const h = harness();
		const pending = deferred<{ getFile: () => Promise<File> }[]>();
		const picker = vi.fn(() => pending.promise);
		h.env.picker = picker;
		h.s.start(h.app, 'restore');
		h.s.enterPhase('choose-file');
		const chosen = h.s.chooseFile();
		expect(picker).toHaveBeenCalledTimes(1);
		expect(picker).toHaveBeenCalledWith({ multiple: false, excludeAcceptAllOption: false });
		expect(h.s.busy).toBe(false);
		pending.reject(new DOMException('closed', 'AbortError'));
		await expect(chosen).resolves.toBeNull();
		expect(h.s.phase).toBe('choose-file');
		expect(h.s.message).toBeNull();
		expect(h.inputs).toHaveLength(0);
	});

	it('returns the picked file from the picker', async () => {
		const h = harness();
		const file = new File(['x'], 'backup.json');
		h.env.picker = vi.fn(async () => [{ getFile: async () => file }]);
		h.s.start(h.app, 'restore');
		await expect(h.s.chooseFile()).resolves.toBe(file);
	});

	// A browser with no picker gets a body-level input with no accept, so an odd file name is never filtered out.
	it('falls back to an input with no accept that is clicked at once and removed after change or cancel', async () => {
		const h = harness();
		h.s.start(h.app, 'restore');
		const chosen = h.s.chooseFile();
		const input = nth(h.inputs, 0);
		expect(input.type).toBe('file');
		expect(input.accept).toBeUndefined();
		expect(input.clicked).toBe(1);
		expect(h.s.busy).toBe(false);
		const file = new File(['y'], 'a.json');
		input.files = [file];
		input.fire('change');
		await expect(chosen).resolves.toBe(file);
		expect(input.removed).toBe(true);

		const second = h.s.chooseFile();
		const cancelled = nth(h.inputs, 1);
		cancelled.fire('cancel');
		await expect(second).resolves.toBeNull();
		expect(cancelled.removed).toBe(true);
	});

	it('a second press drops the first chooser late result and removes its input', async () => {
		const h = harness();
		h.s.start(h.app, 'restore');
		const first = h.s.chooseFile();
		const old = nth(h.inputs, 0);
		const second = h.s.chooseFile();
		const current = nth(h.inputs, 1);
		expect(old.removed).toBe(true);
		old.files = [new File(['late'], 'late.json')];
		old.fire('change');
		await expect(first).resolves.toBeNull();
		const wanted = new File(['now'], 'now.json');
		current.files = [wanted];
		current.fire('change');
		await expect(second).resolves.toBe(wanted);
	});

	// An old chooser answering late must not unseat the open one: a clear still has to find and remove it.
	it('a late answer from a replaced chooser leaves the open chooser tracked', async () => {
		const h = harness();
		h.s.start(h.app, 'restore');
		void h.s.chooseFile();
		const old = nth(h.inputs, 0);
		const open = h.s.chooseFile();
		const current = nth(h.inputs, 1);
		old.files = [new File(['late'], 'late.json')];
		old.fire('change');
		expect(current.removed).toBe(false);
		h.s.end();
		expect(current.removed).toBe(true);
		await expect(open).resolves.toBeNull();
	});

	it('a clear and an end remove an open chooser input and drop its result', async () => {
		const h = harness();
		h.s.start(h.app, 'restore');
		const first = h.s.chooseFile();
		h.s.relockSync('user');
		expect(nth(h.inputs, 0).removed).toBe(true);
		await expect(first).resolves.toBeNull();
		h.s.start(h.app, 'restore');
		const second = h.s.chooseFile();
		h.s.end();
		expect(nth(h.inputs, 1).removed).toBe(true);
		await expect(second).resolves.toBeNull();
	});
});

// ---- hand-offs -------------------------------------------------------------------------------------------------

describe('the erase hand-off', () => {
	// The wizard asks Settings to open the Erase dialog; the request is in memory, taken once, and outlives a clear.
	it('is taken once and survives a session clear', () => {
		const h = harness();
		h.s.start(h.app, 'check');
		h.s.requestErase();
		expect(h.s.eraseRequested).toBe(true);
		h.s.relockSync('user');
		expect(h.s.eraseRequested).toBe(true);
		expect(h.s.takeEraseRequest()).toBe(true);
		expect(h.s.takeEraseRequest()).toBe(false);
		expect(h.s.eraseRequested).toBe(false);
	});
});
