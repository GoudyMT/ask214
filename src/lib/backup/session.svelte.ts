import { flushSync } from 'svelte';
import { RunAbortedError } from '../db/locks';
import type { Relockable } from '../profile/app-init';
import type { ProfileApp } from '../profile/context';
import { IDLE_THRESHOLD_MS } from '../profile/idle-threshold';
import { zeroizeRecord, type RelockReason } from '../profile/lifecycle';
import { BackupError, type BackupCode } from './codes';
import { KDF_WORKER_SRC } from './kdf-paths';
import { makeBackupId, makeBackupNames } from './naming';
import { isWorkerAnswer, type FromWorker, type WorkerRequest } from './worker/protocol';

/**
 * The one backup session of this tab. Make a backup, Restore and Check all drive it, so they share one busy flag, one
 * set of words and one answer to "what happens when the person leaves".
 *
 * A phase is PRE, KEY or COMMIT. PRE holds no key and no plaintext of the person's data, only what they typed or
 * chose: the six words, a save handle, the bytes of a ciphertext file. KEY holds a key, a snapshot or decrypted
 * records, or has a derive running. COMMIT is past the point where anything can be undone.
 *
 * What a relock does follows from the class:
 *   - leaving the app (hygiene): PRE hides what is on screen and keeps everything; KEY stops, drops every key and
 *     returns to the last PRE phase with the words and the file kept; COMMIT only records it.
 *   - a real lock (idle, user, a peer's Lock), the page leaving, Cancel, navigating away: everything is dropped and the
 *     session ends. COMMIT only records it.
 *   - another tab idling: PRE does nothing (the person is working here); KEY stops and keeps the words.
 *
 * A flow (export, restore, check) drives the session through a Run: `beginRun()` takes busy and returns it. The run's
 * `enter`, `hold`, `toPre` and `release` are refused once the run is stale, so a step that finishes after a stop can
 * never write into the session that replaced it. Two kinds of await exist:
 *   - RACED with `untilAborted`: an await that may never settle and produces no plaintext (a worker answer, a picker,
 *     a write to the chosen file, a sliced read of the ciphertext file).
 *   - AWAITED TO THE END, then checked with `run.isCurrent()`: an await that produces plaintext or holds a lock (the
 *     snapshot, a decrypt, the restore writer). When it settles stale, hand what it produced to `run.own` or
 *     `run.ownRecord`: they zero it on the spot and report false.
 * The restore writer takes `run.signal`, `run.mayCommit` and `session.markCommitting`; the last is the writer's
 * synchronous point of no return.
 *
 * What the person reads after a stop: a hide, the deadline and another tab's idle lock set their line at once, because
 * an aborted run can never commit, so "nothing was saved" is already true. Only the person's own Cancel in key work
 * waits (`stopping`) until the in-flight step has settled, and then reports.
 */

/** How long one stretch of machine work may take. Waiting on a person is never timed. */
export const BACKUP_DEADLINE_MS = 60_000;

export type SessionKind = 'export' | 'restore' | 'check';

export type Phase =
	| 'idle'
	// export
	| 'phrase-hidden'
	| 'generating'
	| 'phrase-shown'
	| 'typed-back'
	| 'picking-save'
	| 'save-chosen'
	| 'replace-warning'
	| 'snapshot'
	| 'encrypting'
	| 'verifying'
	| 'saved'
	| 'checking'
	// restore and check
	| 'getting-ready'
	| 'choose-file'
	| 'file-chosen'
	| 'decrypting'
	| 'confirm'
	| 'committed'
	// both
	| 'deriving'
	| 'writing'
	| 'done';

export type PhaseClass = 'PRE' | 'KEY' | 'COMMIT';

export const PHASE_CLASS: Record<Exclude<Phase, 'idle'>, PhaseClass> = {
	'phrase-hidden': 'PRE',
	generating: 'PRE',
	'phrase-shown': 'PRE',
	'typed-back': 'PRE',
	'picking-save': 'PRE',
	'save-chosen': 'PRE',
	'replace-warning': 'PRE',
	snapshot: 'KEY',
	encrypting: 'KEY',
	verifying: 'KEY',
	saved: 'COMMIT',
	checking: 'COMMIT',
	'getting-ready': 'PRE',
	'choose-file': 'PRE',
	'file-chosen': 'PRE',
	decrypting: 'KEY',
	confirm: 'KEY',
	committed: 'COMMIT',
	deriving: 'KEY',
	// Restore `writing` turns COMMIT through `markCommitting`, not through its name.
	writing: 'KEY',
	done: 'COMMIT'
};

/** Why a committing session saw the world move under it. `pagehide` is the page leaving, not a relock. */
export type EpochMover = RelockReason | 'pagehide' | 'navigated';

/**
 * What a flow may hand the session to hold for it. PRE data (`fileBytes`, `parsed`) survives a stopped run; the rest
 * is dropped by it. `saveHandle` is kept by an app switch in a PRE phase and dropped when key work stops.
 */
export type HoldSlot =
	'fileBytes' | 'parsed' | 'saveHandle' | 'key' | 'envelope' | 'confirm' | 'writable';

const HOLD_SLOTS: readonly HoldSlot[] = [
	'fileBytes',
	'parsed',
	'saveHandle',
	'key',
	'envelope',
	'confirm',
	'writable'
];

/** The only phases in which "Show my passphrase" does anything. */
const SHOW_PHASES: readonly Phase[] = ['phrase-hidden', 'phrase-shown', 'typed-back'];

/** Anything a buffer-zeroing step can call. A Uint8Array is one. */
export type Zeroable = { fill: (value: number) => unknown };

/**
 * One attempt (an export, a restore step, a Check). Stale as soon as the session aborts it, ends or starts another.
 * Every method that would change the session returns false and does nothing once the run is stale.
 */
export type Run = {
	readonly id: number;
	/** Aborts the moment the run is stopped; hand it to the restore writer and to `untilAborted`. */
	readonly signal: AbortSignal;
	isCurrent: () => boolean;
	/** Move to a phase. Machine phases arm the deadline, waiting phases disarm it; entering `saved` is the commit. */
	enter: (phase: Phase) => boolean;
	/** The run failed: drop its key work, return to the last PRE phase with the inputs kept, and show `message`. */
	toPre: (message?: BackupCode | null) => boolean;
	hold: (slot: HoldSlot, value: unknown) => boolean;
	/** Take a buffer the run produced; zeroed at once, and false, when the run is already stale. */
	own: (buffer: Zeroable) => boolean;
	/** Same for a decoded record: its byte fields are zeroed with `zeroizeRecord`. */
	ownRecord: (record: Record<string, unknown>) => boolean;
	/** The restore writer's `mayCommit`. */
	mayCommit: () => boolean;
	/** The flow is done with this run (call it in a `finally`). Releases busy if the run is still the current one. */
	release: () => void;
};

export type DeriveResult =
	{ ok: true; key: CryptoKey } | { ok: false; code: BackupCode; position?: 1 | 2 | 3 | 4 | 5 | 6 };

export type StartApp = Pick<ProfileApp, 'status' | 'joinRelock' | 'publish'>;

/** The parts of a Worker the session uses, so a test can stand in for one. */
export type WorkerLike = {
	postMessage: (message: WorkerRequest, transfer?: Transferable[]) => void;
	terminate: () => void;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onmessageerror: ((event: unknown) => void) | null;
};

export type FileInputLike = {
	type: string;
	readonly files: ArrayLike<File> | null;
	addEventListener: (type: 'change' | 'cancel', listener: () => void) => void;
	click: () => void;
	remove: () => void;
};

export type OpenPicker = (options: {
	multiple: false;
	excludeAcceptAllOption: false;
}) => Promise<readonly { getFile: () => Promise<File> }[]>;

/** Everything the session reads from the outside world, so tests drive it with fakes and a fake clock. */
export type SessionDeps = {
	now: () => number;
	mono: () => number;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (timer: unknown) => void;
	getWindow: () => EventTarget;
	isVisible: () => boolean;
	hasFocus: () => boolean;
	createWorker: () => WorkerLike;
	probeWorker: () => Promise<BackupCode>;
	createController: () => AbortController;
	/** A new file input already in the page body, hidden. */
	createInput: () => FileInputLike;
	getOpenPicker: () => OpenPicker | null;
	flush: (fn: () => void) => void;
};

/**
 * Settles with a RunAbortedError the moment `signal` aborts. For an await that may never settle: a terminated worker
 * never answers, and a picker the person walked away from may never resolve. Never use it on an await that produces
 * plaintext: the work behind it keeps going, and its product still has to be zeroed by whoever awaits it to the end.
 */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		p.catch(() => {});
		return Promise.reject(new RunAbortedError());
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(new RunAbortedError());
		signal.addEventListener('abort', onAbort, { once: true });
		p.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			}
		);
	});
}

/**
 * Why the key worker's script did not load, found by asking for the file: it is there (the worker itself failed), it
 * is gone (the app was updated under this page), or the network is down (the code was never downloaded). This is the
 * only request the session makes, and it carries nothing.
 */
export async function mapWorkerLoadFailure(fetchImpl: typeof fetch = fetch): Promise<BackupCode> {
	try {
		const response = await fetchImpl(KDF_WORKER_SRC, { method: 'HEAD' });
		return response.status === 404 ? 'E_APP_UPDATED' : 'E_WORKER_FAILED';
	} catch {
		return 'E_CODE_UNAVAILABLE';
	}
}

/** The worker's script itself failed to load or start, before it said anything. */
class WorkerLoadFailure extends Error {
	constructor() {
		super('E_WORKER_FAILED');
	}
}

type Chooser = {
	input: FileInputLike | null;
	settled: boolean;
	settle: (file: File | null) => void;
};

type DeadlineSpan = 'generate' | 'derive' | 'export' | 'decrypt' | 'write';

function defaultDeps(): SessionDeps {
	return {
		now: () => Date.now(),
		mono: () => performance.now(),
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
		getWindow: () => window,
		isVisible: () => document.visibilityState === 'visible',
		hasFocus: () => document.hasFocus(),
		createWorker: () => new Worker(KDF_WORKER_SRC, { type: 'module' }) as unknown as WorkerLike,
		probeWorker: () => mapWorkerLoadFailure(),
		createController: () => new AbortController(),
		createInput: () => {
			// In the page body, not in any route, so a route that unmounts while the system chooser is open cannot strand
			// the listeners; the session removes it. Hidden: it exists only to be clicked.
			const input = document.createElement('input');
			input.hidden = true;
			document.body.appendChild(input);
			return input;
		},
		getOpenPicker: () => {
			const picker = (window as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker;
			return typeof picker === 'function' ? picker.bind(window) : null;
		},
		flush: (fn) => flushSync(fn)
	};
}

export class BackupSession {
	kind = $state<SessionKind | null>(null);
	phase = $state<Phase>('idle');
	/** The one single-flight flag for every backup row in the tab. */
	busy = $state(false);
	/** True while the screen hides the words and the forms because the person is away. */
	concealed = $state(false);
	/** The words show only when this is true and the screen is not concealed. */
	revealed = $state(false);
	/** The code of the line the person should read, or null. */
	message = $state<BackupCode | null>(null);
	runId = $state(0);
	/** True from the synchronous point of no return: nothing can abort the run from here. */
	committing = $state(false);
	epochMovedBy = $state<EpochMover | null>(null);
	/** When the words appeared; the one source of the label date, the file name date, the created date and the last-backup date. */
	backupAt = $state<number | null>(null);
	backupId = $state<string | null>(null);
	eraseRequested = $state(false);
	/** Cancel pressed in key work: everything is cleared, the outcome waits for the step in flight. */
	stopping = $state(false);
	progress = $state<number | null>(null);
	/** After a restore, a real lock came: the line should say the device locked. */
	lockedAfterRestore = $state(false);
	words = $state.raw<readonly string[] | null>(null);

	#deps: SessionDeps;
	#leave: (() => void) | null = null;
	#ctl: AbortController | null = null;
	#worker: WorkerLike | null = null;
	#pass: ArrayBuffer | null = null;
	#owned: Zeroable[] = [];
	#records: Record<string, unknown>[] = [];
	#holds: Record<HoldSlot, unknown> = BackupSession.#emptyHolds();
	#confirmClose: (() => void) | null = null;
	#inputs: { value: string }[] = [];
	#timer: unknown = null;
	#hiddenWall = 0;
	#hiddenMono = 0;
	#gate: (() => void)[] = [];
	#chooser: Chooser | null = null;
	#stopRunId = -1;
	#sessionToken = 0;
	#stopToken = -1;
	#relockable: Relockable = {
		relockSync: (reason, detail) => this.relockSync(reason, detail),
		refresh: () => this.refresh()
	};
	#onPageHide = (): void => {
		try {
			if (this.phase === 'idle') return;
			if (this.#isCommit()) {
				this.#record('pagehide');
				return;
			}
			this.#clear('pagehide', this.#lockedLine());
		} catch {
			/* a handler of the page leaving never throws */
		}
	};

	constructor(overrides: Partial<SessionDeps> = {}) {
		this.#deps = { ...defaultDeps(), ...overrides };
	}

	static #emptyHolds(): Record<HoldSlot, unknown> {
		return Object.fromEntries(HOLD_SLOTS.map((slot) => [slot, null])) as Record<HoldSlot, unknown>;
	}

	/** True from `start` until the session ends, a clear included. */
	get active(): boolean {
		return this.phase !== 'idle';
	}

	/** Cancel is offered in every phase but COMMIT. */
	get canCancel(): boolean {
		return this.phase !== 'idle' && !this.#isCommit();
	}

	/** The file name and the label a password manager files the words under; both from the one time stamp. */
	get names(): { fileName: string; label: string } | null {
		if (this.backupAt === null || this.backupId === null) return null;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a value built for one read; the reactive inputs are the two fields above
		return makeBackupNames(new Date(this.backupAt), this.backupId);
	}

	// ---- start and end ---------------------------------------------------------------------------------------------

	/**
	 * Opens the session and joins the relock set. Refused unless the app can relock it: a ready app may export, restore
	 * and check; a damaged one may only check; a restore also needs the seam that tells the other tabs.
	 */
	start(app: StartApp, kind: SessionKind): void {
		const join = app.joinRelock;
		const allowed = app.status === 'ready' || (app.status === 'damaged' && kind === 'check');
		if (
			this.phase !== 'idle' ||
			join === null ||
			!allowed ||
			(kind === 'restore' && app.publish === null)
		) {
			throw new BackupError('E_BACKUP_UNAVAILABLE');
		}
		this.#leave = join(this.#relockable);
		this.#sessionToken += 1;
		// No run of an earlier session may ever look current to this one.
		this.runId += 1;
		this.#stopRunId = -1;
		this.stopping = false;
		this.message = null;
		this.epochMovedBy = null;
		this.lockedAfterRestore = false;
		this.committing = false;
		this.kind = kind;
		this.phase = kind === 'export' ? 'phrase-hidden' : 'getting-ready';
		// Registered after the lifecycle's own pagehide handler (which runs first and hides), so the clear comes last.
		this.#deps.getWindow().addEventListener('pagehide', this.#onPageHide);
	}

	/**
	 * Ends the session: drops everything, leaves the relock set. A no-op when idle, and while a write is committing,
	 * which nothing may cut short (the flow ends the session once it reaches `done`).
	 */
	end(): void {
		if (this.phase === 'idle' || this.#isCommit()) return;
		this.#clear('end', null);
	}

	/** Moves to a phase outside any run (the card's own steps). Machine phases arm the deadline, waiting ones disarm it. */
	enterPhase(next: Phase): boolean {
		if (this.phase === 'idle' || next === 'idle') return false;
		const previous = this.#spanOf(this.phase);
		this.phase = next;
		if (next === 'saved') this.committing = true;
		// Past the commit and the read-back there is nothing left to protect from a stop, only a result line to show.
		if (next === 'done') this.committing = false;
		const span = this.#spanOf(next);
		if (span === null) this.#disarm();
		else if (span !== previous || this.#timer === null) this.#arm();
		if (next !== 'deriving') this.progress = null;
		if (next === 'saved' || next === 'committed' || next === 'done') this.#dropSecretsAtCommit();
		return true;
	}

	// ---- runs ------------------------------------------------------------------------------------------------------

	/**
	 * Takes busy and starts a run, or returns null when something is already running (a double click, a held Enter).
	 * Call it synchronously at the top of the handler, before any await.
	 */
	beginRun(): Run | null {
		if (this.phase === 'idle') throw new BackupError('E_BACKUP_UNAVAILABLE');
		if (this.busy) return null;
		this.busy = true;
		this.message = null;
		return this.#makeRun();
	}

	#makeRun(): Run {
		this.runId += 1;
		const id = this.runId;
		const ctl = this.#deps.createController();
		this.#ctl = ctl;
		const signal = ctl.signal;
		const isCurrent = (): boolean => !signal.aborted && id === this.runId;
		return {
			id,
			signal,
			isCurrent,
			enter: (phase) => isCurrent() && this.enterPhase(phase),
			toPre: (message = null) => {
				if (!isCurrent()) return false;
				this.#abortToPre('failure', message);
				return true;
			},
			hold: (slot, value) => {
				if (!isCurrent()) return false;
				this.#holds[slot] = value;
				return true;
			},
			own: (buffer) => {
				if (isCurrent()) {
					this.#owned.push(buffer);
					return true;
				}
				BackupSession.#zero(buffer);
				return false;
			},
			ownRecord: (record) => {
				if (isCurrent()) {
					this.#records.push(record);
					return true;
				}
				BackupSession.#zeroRecord(record);
				return false;
			},
			mayCommit: () => isCurrent(),
			release: () => {
				if (isCurrent()) {
					this.busy = false;
					this.#ctl = null;
					this.#disarm();
					return;
				}
				// The run Cancel stopped has now settled: only then does the person read the outcome.
				if (id === this.#stopRunId && this.#stopToken === this.#sessionToken) {
					this.#stopRunId = -1;
					this.stopping = false;
					this.message = 'E_RESTORE_CANCELLED';
				}
			}
		};
	}

	/** Stops the current run: the run id moves first, then the signal aborts, so anything the abort wakes sees a stale run. */
	abortRun(cause: string): void {
		this.runId += 1;
		const ctl = this.#ctl;
		this.#ctl = null;
		this.#disarm();
		ctl?.abort(cause);
	}

	/**
	 * The restore writer's `onCommitting`, called inside its synchronous block: from here nothing can abort the run,
	 * Cancel leaves, and the deadline is off.
	 */
	markCommitting = (): void => {
		this.committing = true;
		this.#disarm();
	};

	/** What a flow handed the session to hold, or null. */
	held(slot: HoldSlot): unknown {
		return this.#holds[slot];
	}

	// ---- the words and the key worker ------------------------------------------------------------------------------

	/**
	 * "Show my passphrase". The first press asks the worker for the words (once per session); a later press only shows
	 * the same words again. The time stamp is taken when the words appear.
	 */
	async showPassphrase(): Promise<void> {
		if (this.kind !== 'export' || !SHOW_PHASES.includes(this.phase)) return;
		if (this.words !== null) {
			this.revealed = true;
			return;
		}
		// One phrase per session: once the words have appeared and been dropped (the commit), they are never made again.
		if (this.backupAt !== null) return;
		const run = this.beginRun();
		if (run === null) return;
		let worker: WorkerLike | null = null;
		try {
			if (!run.enter('generating')) return;
			worker = this.#deps.createWorker();
			this.#worker = worker;
			const answer = this.#listen(worker, run);
			worker.postMessage({ op: 'generate' });
			const reply = await untilAborted(answer, run.signal);
			if (reply.type === 'error') throw new BackupError(reply.code);
			if (reply.type !== 'words') throw new BackupError('E_WORKER_FAILED');
			if (!run.isCurrent()) return;
			this.#terminate(worker);
			this.words = reply.words;
			this.backupAt = this.#deps.now();
			this.backupId = makeBackupId();
			this.revealed = true;
			run.enter('phrase-shown');
		} catch (error) {
			if (error instanceof RunAbortedError) return;
			const code = await this.#codeFor(error, run);
			if (code !== null) run.toPre(code);
		} finally {
			if (worker !== null) this.#terminate(worker);
			run.release();
		}
	}

	/**
	 * Derives the key from the typed words in the worker. Waits, in a PRE phase, until the page is visible and has
	 * focus (a password manager prompt that takes focus is a pause, not a failure); then enters `deriving`, transfers
	 * the passphrase buffer to the worker and holds the key it answers with. Settles with a result for anything the
	 * worker or its loading can do, and rejects RunAbortedError when the run is stopped (the session has already said
	 * why). The caller moves on with `run.enter` or ends with `run.toPre(result.code)`.
	 */
	async derive(
		run: Run,
		request: { purpose: 'export' | 'restore'; pass: ArrayBuffer; salt: Uint8Array<ArrayBuffer> }
	): Promise<DeriveResult> {
		const pass = request.pass;
		if (!run.isCurrent()) {
			BackupSession.#zero(new Uint8Array(pass));
			throw new RunAbortedError();
		}
		this.#pass = pass;
		let worker: WorkerLike | null = null;
		try {
			if (!this.#keyReady()) await this.#waitKeyReady(run.signal);
			if (!run.enter('deriving')) throw new RunAbortedError();
			const toSend = this.#pass;
			if (toSend === null) throw new RunAbortedError();
			worker = this.#deps.createWorker();
			this.#worker = worker;
			const answer = this.#listen(worker, run);
			worker.postMessage(
				{ op: 'derive', purpose: request.purpose, pass: toSend, salt: request.salt },
				[toSend]
			);
			// Detached by the post: this reference is dropped, never filled.
			this.#pass = null;
			const reply = await untilAborted(answer, run.signal);
			if (reply.type === 'key') {
				if (!run.hold('key', reply.key)) throw new RunAbortedError();
				return { ok: true, key: reply.key };
			}
			if (reply.type === 'error') {
				return reply.position === undefined
					? { ok: false, code: reply.code }
					: { ok: false, code: reply.code, position: reply.position };
			}
			return { ok: false, code: 'E_WORKER_FAILED' };
		} catch (error) {
			if (error instanceof RunAbortedError) throw error;
			const code = await this.#codeFor(error, run);
			if (code === null) throw new RunAbortedError();
			return { ok: false, code };
		} finally {
			if (worker !== null) this.#terminate(worker);
			if (this.#pass === pass) {
				this.#pass = null;
				BackupSession.#zero(new Uint8Array(pass));
			}
		}
	}

	/** Listens to one worker for its first real answer; progress updates the bar and is not an answer. */
	#listen(worker: WorkerLike, run: Run): Promise<FromWorker> {
		let heard = false;
		return new Promise<FromWorker>((resolve, reject) => {
			worker.onmessage = (event) => {
				if (!isWorkerAnswer(event.data)) {
					reject(new BackupError('E_WORKER_FAILED'));
					return;
				}
				heard = true;
				if (event.data.type === 'progress') {
					if (run.isCurrent()) this.progress = event.data.percent;
					return;
				}
				resolve(event.data);
			};
			worker.onmessageerror = () => reject(new BackupError('E_WORKER_FAILED'));
			// A script that never loaded says nothing first; one that failed after talking is an ordinary failure.
			worker.onerror = () =>
				reject(heard ? new BackupError('E_WORKER_FAILED') : new WorkerLoadFailure());
		});
	}

	/** The code to show for a worker failure, or null when the run was stopped while the probe ran. */
	async #codeFor(error: unknown, run: Run): Promise<BackupCode | null> {
		let code: BackupCode;
		if (error instanceof BackupError) code = error.code;
		else if (error instanceof WorkerLoadFailure) {
			try {
				code = await untilAborted(this.#deps.probeWorker(), run.signal);
			} catch {
				return null;
			}
		} else code = 'E_WORKER_FAILED';
		return run.isCurrent() ? code : null;
	}

	#terminate(worker: WorkerLike): void {
		if (this.#worker !== worker) return;
		this.#worker = null;
		try {
			worker.terminate();
		} catch {
			/* a worker that will not stop is still dropped */
		}
	}

	#keyReady(): boolean {
		return this.#deps.isVisible() && this.#deps.hasFocus();
	}

	/** Resolves when the page is visible and focused: on `focus`, or when a lifecycle refresh finds it so. */
	#waitKeyReady(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(new RunAbortedError());
		const win = this.#deps.getWindow();
		return untilAborted(
			new Promise<void>((resolve) => {
				const cleanup = (): void => {
					win.removeEventListener('focus', check);
					this.#gate = this.#gate.filter((fn) => fn !== check);
				};
				const check = (): void => {
					if (!this.#keyReady()) return;
					cleanup();
					resolve();
				};
				win.addEventListener('focus', check);
				this.#gate.push(check);
				signal.addEventListener('abort', cleanup, { once: true });
			}),
			signal
		);
	}

	// ---- the file chooser ------------------------------------------------------------------------------------------

	/**
	 * Opens the system file chooser. Call it as the first statement of the click handler: the picker needs the click's
	 * activation, and nothing here awaits before it opens. Resolves to the chosen file, or null for a cancel, a chooser
	 * that was replaced, a clear, or a chooser that failed. No busy flag is taken: a back-out may settle nothing.
	 */
	chooseFile(): Promise<File | null> {
		this.#dropChooser();
		const chooser: Chooser = { input: null, settled: false, settle: () => {} };
		const done = new Promise<File | null>((resolve) => {
			chooser.settle = (file) => {
				if (chooser.settled) return;
				chooser.settled = true;
				resolve(file);
			};
		});
		this.#chooser = chooser;
		const arrived = (file: File | null): void => {
			// A result from a chooser that was replaced or cleared is dropped, and must not disturb the one now open.
			if (this.#chooser !== chooser) {
				chooser.settle(null);
				return;
			}
			this.#chooser = null;
			try {
				chooser.input?.remove();
			} catch {
				/* already gone */
			}
			chooser.settle(file);
		};
		try {
			const picker = this.#deps.getOpenPicker();
			if (picker !== null) {
				// No `types`: a filter would hide a renamed backup.
				picker({ multiple: false, excludeAcceptAllOption: false })
					.then((handles) => handles[0]?.getFile() ?? null)
					.then(arrived, () => arrived(null));
			} else {
				const input = this.#deps.createInput();
				chooser.input = input;
				input.type = 'file';
				input.addEventListener('change', () => arrived(input.files?.[0] ?? null));
				input.addEventListener('cancel', () => arrived(null));
				input.click();
			}
		} catch {
			arrived(null);
		}
		return done;
	}

	#dropChooser(): void {
		const chooser = this.#chooser;
		this.#chooser = null;
		if (chooser === null) return;
		try {
			chooser.input?.remove();
		} catch {
			/* already gone */
		}
		chooser.settle(null);
	}

	// ---- inputs and the confirm the card owns -----------------------------------------------------------------------

	/**
	 * The card registers each field the session must wipe on a clear. These are NOT the profile's secure inputs: the
	 * profile wipes those on every app switch, and an app switch must keep what the person typed. Returns unregister.
	 */
	registerInput(el: { value: string }): () => void {
		this.#inputs.push(el);
		return () => {
			this.#inputs = this.#inputs.filter((item) => item !== el);
		};
	}

	/** The card registers how to close its confirm dialog; a stop calls it. Returns unregister. */
	registerConfirm(close: () => void): () => void {
		this.#confirmClose = close;
		return () => {
			if (this.#confirmClose === close) this.#confirmClose = null;
		};
	}

	// ---- cancel, navigation, erase ---------------------------------------------------------------------------------

	/**
	 * The person pressed Cancel, or left the page the card is on. Clears everything at once. In key work the outcome
	 * line waits for the in-flight step (`stopping` until the run releases). False, and nothing happens, in COMMIT.
	 */
	cancel(reason: 'user-cancel' | 'navigated' = 'user-cancel'): boolean {
		if (!this.canCancel) return false;
		const inFlight =
			PHASE_CLASS[this.phase as Exclude<Phase, 'idle'>] === 'KEY' && this.#ctl !== null;
		const stopId = this.runId;
		this.#clear(reason, null);
		if (inFlight && reason === 'user-cancel') {
			this.#stopRunId = stopId;
			this.#stopToken = this.#sessionToken;
			this.stopping = true;
		}
		return true;
	}

	/**
	 * The card is leaving the page. Cancels only when the person actually moved to another route: a card swapped out
	 * by an app switch is concealed or the page is hidden, and must keep its session.
	 */
	cardGone(): void {
		if (this.phase === 'idle' || this.concealed || !this.#deps.isVisible()) return;
		// A write that has begun runs on; the export read-back learns the person left and stops with its own line.
		if (this.#isCommit()) this.#record('navigated');
		else this.cancel('navigated');
	}

	/** The wizard asks Settings to open the Erase dialog. In memory only; never in history. */
	requestErase(): void {
		this.eraseRequested = true;
	}

	takeEraseRequest(): boolean {
		const requested = this.eraseRequested;
		this.eraseRequested = false;
		return requested;
	}

	// ---- relock ----------------------------------------------------------------------------------------------------

	/** The relock set's entry point; never throws, so it can never break the walk of the stores after it. */
	relockSync(reason: RelockReason, detail?: { peerReason?: 'idle' | 'user' }): void {
		try {
			this.#relock(reason, detail);
		} catch {
			/* the walk of the other stores must go on */
		}
	}

	#relock(reason: RelockReason, detail?: { peerReason?: 'idle' | 'user' }): void {
		if (this.phase === 'idle') return;
		if (this.#isCommit()) {
			this.#record(reason);
			if (this.phase === 'committed' && reason !== 'hygiene') this.lockedAfterRestore = true;
			return;
		}
		const isKey = PHASE_CLASS[this.phase] === 'KEY';
		if (this.phase === 'done') {
			// Nothing secret is held in done: an app switch and another tab idling change nothing, and a real lock just
			// closes the result without a LOCKED line.
			if (reason === 'hygiene' || (reason === 'peer' && detail?.peerReason === 'idle')) return;
			this.#clear(reason, null);
			return;
		}
		if (reason === 'hygiene') {
			if (isKey) this.#abortToPre('hygiene', 'E_LEFT_APP');
			else if (this.phase === 'generating') this.#abortToPre('hygiene', null);
			this.#conceal();
			return;
		}
		if (reason === 'peer' && detail?.peerReason === 'idle') {
			// Another tab idling is not this person leaving: the words stay and nothing is hidden.
			if (isKey) this.#abortToPre('peer-idle', 'E_LOCKED');
			return;
		}
		this.#clear(reason, 'E_LOCKED');
	}

	/**
	 * The page came back. Starts a key run that was waiting for focus, then un-conceals, unless the page is still
	 * hidden or the person was away too long: the idle timer cannot run in a frozen page, so the time away is checked
	 * here on both clocks, and the words are never mounted again once it has passed. Never decrypts.
	 */
	refresh(): Promise<void> {
		try {
			this.#refresh();
		} catch {
			/* a lifecycle event never fails the page */
		}
		return Promise.resolve();
	}

	#refresh(): void {
		for (const check of [...this.#gate]) check();
		if (this.phase === 'idle' || !this.concealed || !this.#deps.isVisible()) return;
		const wall = this.#deps.now();
		const away = IDLE_THRESHOLD_MS;
		const expired =
			wall < this.#hiddenWall ||
			wall - this.#hiddenWall >= away ||
			this.#deps.mono() - this.#hiddenMono >= away;
		if (expired && this.#isCommit()) {
			// A write that has begun is never cleared from under itself; its words are already gone.
			this.#record('idle');
			this.#setConcealed(false);
		} else if (expired) this.#clear('idle', this.#lockedLine());
		else this.#setConcealed(false);
	}

	/** The line a clear leaves behind: a result that was already finished is closed without one. */
	#lockedLine(): BackupCode | null {
		return this.phase === 'done' ? null : 'E_LOCKED';
	}

	#conceal(): void {
		// The first conceal of an absence stamps both clocks; a second hide during the same absence must not move them.
		if (!this.concealed) {
			this.#hiddenWall = this.#deps.now();
			this.#hiddenMono = this.#deps.mono();
		}
		this.#setConcealed(true);
	}

	/** Changes `concealed` and lets the screen follow in the same task, before the system can take a picture of it. */
	#setConcealed(value: boolean): void {
		try {
			this.#deps.flush(() => {
				this.concealed = value;
			});
		} catch {
			/* the flush is a courtesy; the state change below is the point */
		}
		if (this.concealed !== value) this.concealed = value;
	}

	#isCommit(): boolean {
		return (
			this.committing ||
			(this.phase !== 'idle' && this.phase !== 'done' && PHASE_CLASS[this.phase] === 'COMMIT')
		);
	}

	/**
	 * A stop that cannot touch a committing session is only written down. An app switch and a navigation are weak:
	 * the first real lock or page leave outranks them, and nothing outranks that.
	 */
	#record(mover: EpochMover): void {
		const weak = (m: EpochMover): boolean => m === 'hygiene' || m === 'navigated';
		if (this.epochMovedBy === null || (weak(this.epochMovedBy) && !weak(mover))) {
			this.epochMovedBy = mover;
		}
	}

	// ---- the walk --------------------------------------------------------------------------------------------------

	/**
	 * The one teardown, each step in its own try so that a throw in one never skips the rest. Order matters:
	 * (a) abort the run unless it is committing, (b) stop the worker, (c) drop the passphrase buffer, (d) zero what the
	 * run owns, (e) drop the key and the other key holdings, (f) close the confirm, (g) on a clear, wipe the inputs.
	 */
	#teardown(cause: string, clear: boolean): void {
		const steps: (() => void)[] = [
			() => {
				if (!this.committing) this.abortRun(cause);
			},
			() => {
				const worker = this.#worker;
				this.#worker = null;
				worker?.terminate();
			},
			() => this.#dropPass(),
			() => this.#zeroOwned(),
			() => this.#dropKeyHoldings(true),
			() => this.#confirmClose?.(),
			() => {
				if (!clear) return;
				this.#scrubInputs();
				this.#dropChooser();
			}
		];
		for (const step of steps) {
			try {
				step();
			} catch {
				/* isolated */
			}
		}
	}

	/** Key work stopped: back to the last PRE phase with the words and the file kept. */
	#abortToPre(cause: string, message: BackupCode | null): void {
		this.#teardown(cause, false);
		this.#disarm();
		this.busy = false;
		this.progress = null;
		this.phase = this.#preFor();
		this.message = message;
	}

	/** Everything dropped and the session ended; `message` is what the person reads afterwards. */
	#clear(cause: string, message: BackupCode | null): void {
		this.#teardown(cause, true);
		this.#disarm();
		this.busy = false;
		this.progress = null;
		this.words = null;
		this.revealed = false;
		this.backupAt = null;
		this.backupId = null;
		this.#holds = BackupSession.#emptyHolds();
		this.committing = false;
		this.kind = null;
		this.phase = 'idle';
		this.message = message;
		// The words are gone, so the screen needs no hiding: set directly, never through a render that could mount them.
		this.concealed = false;
		const leave = this.#leave;
		this.#leave = null;
		try {
			leave?.();
		} catch {
			/* leaving twice, or a set that is gone, is not an error */
		}
		try {
			this.#deps.getWindow().removeEventListener('pagehide', this.#onPageHide);
		} catch {
			/* no window to remove from */
		}
	}

	/** The last phase the person can act in, which a stopped run returns to. */
	#preFor(): Phase {
		if (this.phase === 'generating') return 'phrase-hidden';
		return this.kind === 'export' ? 'typed-back' : 'file-chosen';
	}

	#dropPass(): void {
		const pass = this.#pass;
		this.#pass = null;
		// Only a buffer the page still owns is wiped; one that was posted is detached and has no length.
		if (pass !== null && pass.byteLength > 0) BackupSession.#zero(new Uint8Array(pass));
	}

	#zeroOwned(): void {
		const owned = this.#owned;
		const records = this.#records;
		this.#owned = [];
		this.#records = [];
		for (const buffer of owned) BackupSession.#zero(buffer);
		for (const record of records) BackupSession.#zeroRecord(record);
	}

	/**
	 * Drops every key holding. A stop (`abortWritable`) also aborts a half-written file and drops the envelope; a
	 * commit does neither: the file is being closed, and the ciphertext envelope is what the read-back compares.
	 */
	#dropKeyHoldings(abortWritable: boolean): void {
		const writable = this.#holds.writable as { abort?: () => unknown } | null;
		this.#holds.key = null;
		if (abortWritable) this.#holds.envelope = null;
		this.#holds.confirm = null;
		this.#holds.writable = null;
		this.#holds.saveHandle = null;
		if (abortWritable && writable !== null && typeof writable.abort === 'function') {
			try {
				// Not awaited: an abort that rejects is nothing the person can act on.
				void Promise.resolve(writable.abort()).catch(() => {});
			} catch {
				/* the abort threw before it started */
			}
		}
	}

	#scrubInputs(): void {
		for (const input of this.#inputs) {
			try {
				input.value = '';
			} catch {
				/* the next field is still wiped */
			}
		}
	}

	/** The commit point: nothing secret is needed past it, so it goes now; the ciphertext envelope stays. */
	#dropSecretsAtCommit(): void {
		const steps: (() => void)[] = [
			() => {
				const worker = this.#worker;
				this.#worker = null;
				worker?.terminate();
			},
			() => this.#dropPass(),
			() => this.#zeroOwned(),
			() => this.#dropKeyHoldings(false),
			() => {
				this.words = null;
				this.revealed = false;
				this.#holds.fileBytes = null;
				this.#holds.parsed = null;
			},
			() => this.#scrubInputs()
		];
		for (const step of steps) {
			try {
				step();
			} catch {
				/* isolated */
			}
		}
	}

	static #zero(buffer: Zeroable): void {
		try {
			buffer.fill(0);
		} catch {
			/* one buffer that cannot be filled never strands the next */
		}
	}

	static #zeroRecord(record: Record<string, unknown>): void {
		try {
			zeroizeRecord(record);
		} catch {
			/* same */
		}
	}

	// ---- the deadline ----------------------------------------------------------------------------------------------

	/** Which stretch of machine work a phase belongs to, or null when the phone is waiting on a person or past commit. */
	#spanOf(phase: Phase): DeadlineSpan | null {
		if (this.committing || phase === 'idle') return null;
		switch (phase) {
			case 'generating':
				return 'generate';
			case 'deriving':
				return 'derive';
			case 'snapshot':
			case 'encrypting':
			case 'verifying':
				return 'export';
			case 'writing':
				return this.kind === 'export' ? 'export' : 'write';
			case 'decrypting':
				return 'decrypt';
			default:
				return null;
		}
	}

	#arm(): void {
		this.#disarm();
		this.#timer = this.#deps.setTimer(() => this.#onDeadline(), BACKUP_DEADLINE_MS);
	}

	#disarm(): void {
		if (this.#timer !== null) this.#deps.clearTimer(this.#timer);
		this.#timer = null;
	}

	#onDeadline(): void {
		this.#timer = null;
		try {
			if (this.phase === 'idle' || this.#isCommit()) return;
			this.#abortToPre('deadline', 'E_TOOK_TOO_LONG');
		} catch {
			/* a timer callback never throws */
		}
	}
}

/** The session every backup row in this tab drives. */
export const backupSession = new BackupSession();
