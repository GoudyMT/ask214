import { resolve } from '$app/paths';
import { createSubscriber } from 'svelte/reactivity';
import { waitForControl } from '../ask/when-controlled';
import { RunAbortedError } from '../db/locks';
import type { ProfileApp } from '../profile/context';
import { readDeviceState, type DeviceState } from '../profile/device-state';
import {
	KeystoreHmacMismatchError,
	KeystoreNotInitializedError,
	readKeystoreRow
} from '../profile/store.svelte';
import { localTodayIso } from '../timeline/day-math';
import { formatTimelineDate } from '../timeline/format-date';
import { SKILLBRIDGE_PLAN_KEY } from '../timeline/skillbridge-key';
import { BackupError, toBackupCode, type BackupCode } from './codes';
import {
	backupMessage,
	checkOpensLine,
	DEVICE_NO_DATA_LINE,
	deviceChangedLine,
	deviceMatchesLine,
	LOCKED_AFTER_RESTORE_LINE,
	RESTORED_RELOAD_LINE,
	RESTORED_UNLOCK_LINE,
	type MessageContext
} from './copy';
import { BACKUP_RELEASE_DATE, formatBackupDate } from './dates';
import { decryptEnvelope, readBackupFile, type ParsedEnvelope } from './envelope';
import { markBackupIntent } from './intent';
import { parseBackupLabel } from './naming';
import { canonicalizePhrase, type PhrasePosition } from './phrase';
import { restoreBackup, type RestoreFailureCode, type RestoreGens } from './restore-writer';
import { untilAborted, type BackupSession, type Run, type SessionKind } from './session.svelte';
import { validateInner, type ValidInner } from './validate';

/**
 * The restore and Check flow: everything a person does between "Restore" (or "Check a backup") and the result, driven
 * through the one BackupSession. The card draws what `view` says and calls the methods; it holds no rule of its own.
 *
 * The order is fixed so nothing is written before the person has seen the truth:
 *   1. the row waits until the app can run offline (the key worker comes from the service worker's cache);
 *   2. the person picks any file (no type filter: a renamed backup must still be choosable), it is read through a
 *      bounded slice and checked for shape, with no key work;
 *   3. the six words are folded and sent to the worker, the file is opened, and the inside is checked field by field;
 *   4. only then is the device read, ONCE, and the confirm built from that one read. The confirm does not exist until
 *      the read has resolved, so there is nothing to press before then;
 *   5. Replace opens and checks the held file again, and only then calls the writer, whose single transaction either
 *      replaces everything or nothing. Check stops after step 3 and never touches the device.
 *
 * A failure of the person's input (a word that is not on the list, a wrong word order) returns to the file step with
 * the typed words still in their field. The words are never stored here: the card passes the text in, it is folded and
 * posted, and no message, error or code carries a word, a byte of the file or a record. A line that names a word names
 * its position only.
 */

/**
 * What the file holds, said as which kinds of thing it has and how many, plus the backup's own date. Never a value:
 * no date the person set, no note text.
 */
export type BackupSummary = {
	madeOn: string;
	label: string | null;
	/** Always true for a file that passed the check: a backup comes from a finished setup. */
	separationDate: boolean;
	skillbridgeStart: boolean;
	terminalLeaveStart: boolean;
	tasks: number;
	notes: number;
	calendarExclusions: number;
	calendarCard: boolean;
};

/** What the confirm was built from. It holds no key, no plaintext and no record: Replace opens the file again. */
export type ConfirmHold = {
	/** The generations the person read; the writer refuses with DEVICE_MOVED if any has moved since. */
	gens: RestoreGens;
	installUuid: Uint8Array;
	summary: BackupSummary;
	deviceLine: string;
	warning: boolean;
	/** Set when Replace found the device had moved and the details were read again. */
	notice: BackupCode | null;
};

type HeldFile = { envelope: ParsedEnvelope; label: string | null };

type After = 'reloading' | 'unlock' | 'reload';

export type FlowView = {
	kind: SessionKind | null;
	/** The line to show for the session's current message, or null. */
	line: string | null;
	/** The label to show beside the file when its name is the one the app gave it. */
	label: string | null;
	/** Bumps each time the passphrase field should take focus back with its text kept. */
	focusField: number;
	/** A wrong passphrase on Check: offer "Make a new backup now". */
	offerNewBackup: boolean;
	/** The device's data is damaged: offer to erase it. */
	offerErase: boolean;
	confirm: ConfirmHold | null;
	/** Check passed: "This backup opens". */
	checked: { line: string; summary: BackupSummary } | null;
	/** The restore was written. `line` is null while the page is about to reload on its own. */
	restored: { line: string | null; reloadButton: boolean } | null;
};

/** The seams a test stands in for. Everything else is the real thing. */
export type FlowDeps = {
	session: BackupSession;
	app: Pick<ProfileApp, 'status' | 'joinRelock' | 'publish' | 'store' | 'reloadOnUnlock'>;
	/** The open database; Check never reads it, so it may be null where there is none. */
	db: IDBDatabase | null;
	waitForControl?: () => Promise<boolean>;
	/** The one device read that builds the confirm: the verified state and the install it was read on. */
	readDevice?: (db: IDBDatabase) => Promise<{ state: DeviceState; installUuid: Uint8Array }>;
	reload?: () => void;
	replace?: (path: string) => void;
	isVisible?: () => boolean;
	/** Calls `fn` once the page is next visible; returns how to stop waiting. */
	onceVisible?: (fn: () => void) => () => void;
	timelinePath?: () => string;
};

async function readDeviceNow(
	db: IDBDatabase
): Promise<{ state: DeviceState; installUuid: Uint8Array }> {
	const keystore = await readKeystoreRow(db);
	const state = await readDeviceState(db);
	return { state, installUuid: new Uint8Array(keystore.installUuid) };
}

function onceVisibleNow(fn: () => void): () => void {
	const listener = (): void => {
		if (document.visibilityState !== 'visible') return;
		document.removeEventListener('visibilitychange', listener);
		fn();
	};
	document.addEventListener('visibilitychange', listener);
	return () => document.removeEventListener('visibilitychange', listener);
}

/** The code a device read that failed stands for. */
function deviceReadCode(e: unknown): BackupCode {
	if (e instanceof KeystoreNotInitializedError) return 'E_RESTORE_DEVICE_CHANGED';
	if (e instanceof KeystoreHmacMismatchError) return 'E_RESTORE_DEVICE_DAMAGED';
	if (e instanceof Error && e.message === 'E_RESTORE_DEVICE_DAMAGED') {
		return 'E_RESTORE_DEVICE_DAMAGED';
	}
	// Nothing was written by a read, so this is the same promise as a failed write.
	return 'E_WRITE_FAILED';
}

function summarize(inner: ValidInner, label: string | null): BackupSummary {
	// The SkillBridge plan's answer is stored beside the tasks but is not one on the person's list.
	const tasks = Object.entries(inner.stores['timeline-state']?.tasks ?? {})
		.filter(([id]) => id !== SKILLBRIDGE_PLAN_KEY)
		.map(([, task]) => task);
	const calendar = inner.stores['calendar-sync'];
	const profile = inner.stores.profile;
	return {
		madeOn: formatBackupDate(inner.createdAt),
		label,
		separationDate: true,
		skillbridgeStart: profile.skillbridgeStart !== undefined,
		terminalLeaveStart: profile.terminalLeaveStart !== undefined,
		tasks: tasks.length,
		notes: tasks.filter((task) => task.notes !== undefined).length,
		calendarExclusions: calendar
			? calendar.exclusions.taskIds.length + calendar.exclusions.categories.length
			: 0,
		calendarCard: calendar?.card !== undefined
	};
}

/**
 * What this device holds now, from the one read, against the backup being restored. Three cases: nothing saved yet;
 * exactly the content of a backup made or restored here (the three generations still match the mark); or changes made
 * since, dated by the newest write. A backup whose own date is unknown warns in the third case, because the device's
 * changes cannot be shown to be older.
 */
function describeDevice(state: DeviceState, createdAt: number): { line: string; warning: boolean } {
	const { gens, ts, mark } = state;
	if (gens.profile < 1 && gens.timeline < 1 && gens.calendar < 1) {
		return { line: DEVICE_NO_DATA_LINE, warning: false };
	}
	if (
		mark !== null &&
		mark.gens.profile === gens.profile &&
		mark.gens.timeline === gens.timeline &&
		mark.gens.calendar === gens.calendar
	) {
		return { line: deviceMatchesLine(formatBackupDate(mark.at)), warning: mark.at > createdAt };
	}
	const written = [
		gens.profile >= 1 ? ts.profile : null,
		gens.timeline >= 1 ? ts.timeline : null,
		gens.calendar >= 1 ? ts.calendar : null
	].filter((at): at is number => at !== null);
	if (written.length === 0) return { line: DEVICE_NO_DATA_LINE, warning: false };
	const newest = Math.max(...written);
	return {
		// The cutoff of formatBackupDate is for a backup's stamp. The phone's own write times come from its own clock and
		// are real however old, so a phone last saved before the release still names its day.
		line: deviceChangedLine(formatTimelineDate(localTodayIso(new Date(newest)))),
		warning: newest > createdAt || createdAt < BACKUP_RELEASE_DATE
	};
}

const isLockReason = (mover: string | null): boolean =>
	mover === 'idle' || mover === 'user' || mover === 'peer';

export class RestoreFlow {
	readonly #session: BackupSession;
	readonly #app: FlowDeps['app'];
	readonly #db: IDBDatabase | null;
	readonly #waitForControl: () => Promise<boolean>;
	readonly #readDevice: NonNullable<FlowDeps['readDevice']>;
	readonly #reload: () => void;
	readonly #replace: (path: string) => void;
	readonly #isVisible: () => boolean;
	readonly #onceVisible: NonNullable<FlowDeps['onceVisible']>;
	readonly #timelinePath: () => string;

	#position: PhrasePosition | null = null;
	#numbers = false;
	#focus = 0;
	#offerNewBackup = false;
	#offerErase = false;
	#checked: { line: string; summary: BackupSummary } | null = null;
	#after: After | null = null;
	#stopWaiting: (() => void) | null = null;
	readonly #updates = new Set<() => void>();
	readonly #subscribe = createSubscriber((update) => {
		this.#updates.add(update);
		return () => {
			this.#updates.delete(update);
		};
	});

	constructor(deps: FlowDeps) {
		this.#session = deps.session;
		this.#app = deps.app;
		this.#db = deps.db;
		this.#waitForControl = deps.waitForControl ?? waitForControl;
		this.#readDevice = deps.readDevice ?? readDeviceNow;
		this.#reload = deps.reload ?? ((): void => location.reload());
		this.#replace = deps.replace ?? ((path: string): void => location.replace(path));
		this.#isVisible = deps.isVisible ?? ((): boolean => document.visibilityState === 'visible');
		this.#onceVisible = deps.onceVisible ?? onceVisibleNow;
		this.#timelinePath = deps.timelinePath ?? ((): string => resolve('/timeline'));
	}

	// ---- what the card reads -----------------------------------------------------------------------------------------

	/** The confirm, or null until the device read has resolved. The card draws the confirm only from this. */
	get confirm(): ConfirmHold | null {
		const held = this.#session.held('confirm');
		return typeof held === 'object' && held !== null ? (held as ConfirmHold) : null;
	}

	get view(): FlowView {
		this.#subscribe();
		const session = this.#session;
		const file = this.#heldFile();
		const code = session.message;
		return {
			kind: session.kind,
			line: code === null ? null : this.lineFor(code),
			label: file?.label ?? null,
			focusField: this.#focus,
			offerNewBackup: this.#offerNewBackup,
			offerErase: this.#offerErase,
			confirm: session.phase === 'confirm' ? this.confirm : null,
			checked: session.phase === 'done' ? this.#checked : null,
			restored: this.#restoredView()
		};
	}

	/** The text for a code on this path, with the position, count hint and label this flow last learned. */
	lineFor(code: BackupCode): string | null {
		const ctx: MessageContext = { path: this.#session.kind === 'check' ? 'check' : 'restore' };
		if (this.#position !== null) ctx.position = this.#position;
		if (this.#numbers) ctx.numbers = true;
		const label = this.#heldFile()?.label;
		if (label !== null && label !== undefined) ctx.label = label;
		return backupMessage(code, ctx);
	}

	#heldFile(): HeldFile | null {
		const held = this.#session.held('parsed');
		return typeof held === 'object' && held !== null ? (held as HeldFile) : null;
	}

	#restoredView(): FlowView['restored'] {
		if (this.#after === null || this.#session.phase !== 'committed') return null;
		if (this.#after === 'reloading') return { line: null, reloadButton: false };
		if (this.#after === 'reload') return { line: RESTORED_RELOAD_LINE, reloadButton: true };
		return {
			line: this.#session.lockedAfterRestore ? LOCKED_AFTER_RESTORE_LINE : RESTORED_UNLOCK_LINE,
			reloadButton: false
		};
	}

	#notify(): void {
		for (const update of [...this.#updates]) update();
	}

	// ---- the row ---------------------------------------------------------------------------------------------------

	/** Opens the row: waits until the app can run offline, then lets the person choose a file. */
	async open(kind: 'restore' | 'check'): Promise<void> {
		if (kind === 'restore' && this.#db === null) throw new BackupError('E_BACKUP_UNAVAILABLE');
		const session = this.#session;
		session.start(this.#app, kind);
		this.#position = null;
		this.#numbers = false;
		this.#offerNewBackup = false;
		this.#offerErase = false;
		this.#checked = null;
		this.#after = null;
		this.#notify();
		const at = session.runId;
		// True and false both move on: a page no worker controls still restores, only from the network.
		await this.#waitForControl().catch(() => false);
		if (session.runId !== at || session.phase !== 'getting-ready') return;
		session.enterPhase('choose-file');
	}

	/** "Choose file". The chooser opens before anything else runs, because it needs the click's activation. */
	async chooseFile(): Promise<void> {
		const chosen = this.#session.chooseFile();
		const file = await chosen;
		const session = this.#session;
		if (file === null || (session.phase !== 'choose-file' && session.phase !== 'file-chosen'))
			return;
		const run = session.beginRun();
		if (run === null) return;
		this.#clearMarks();
		try {
			// A new choice replaces the old one whatever happens to it.
			run.hold('parsed', null);
			const read = await untilAborted(readBackupFile(file), run.signal);
			if (!run.isCurrent()) return;
			if (!read.ok) {
				run.toPre(read.code);
				session.enterPhase('choose-file');
				return;
			}
			const held: HeldFile = { envelope: read.envelope, label: parseBackupLabel(file.name) };
			run.hold('parsed', held);
			run.enter('file-chosen');
		} catch (e) {
			if (e instanceof RunAbortedError) return;
			// A file that cannot be read at all is treated as a damaged copy.
			run.toPre('E_DAMAGED');
			session.enterPhase('choose-file');
		} finally {
			run.release();
			this.#notify();
		}
	}

	/**
	 * The six words, as typed. Folded here, posted to the worker, and never kept: a wrong word or a wrong order returns
	 * to the file step and the card's field keeps its text.
	 */
	async submit(text: string): Promise<void> {
		const session = this.#session;
		if (session.phase !== 'file-chosen') return;
		const run = session.beginRun();
		if (run === null) return;
		this.#clearMarks();
		let stage: 'worker' | 'crypto' | 'content' = 'worker';
		try {
			const file = this.#heldFile();
			if (file === null) return;
			const phrase = canonicalizePhrase(text);
			if (!phrase.ok) {
				if (phrase.code === 'E_WORD_COUNT') this.#numbers = phrase.numbers;
				else this.#position = phrase.position;
				this.#failInput(run, phrase.code);
				return;
			}
			const derived = await session.derive(run, {
				purpose: 'restore',
				pass: phrase.bytes.buffer,
				salt: file.envelope.salt
			});
			if (!derived.ok) {
				if (derived.position !== undefined) this.#position = derived.position;
				this.#failInput(run, derived.code);
				return;
			}

			stage = 'crypto';
			if (!run.enter('decrypting')) return;
			// Awaited to its end, then checked: the decrypt's bytes are wiped inside it whatever the run became.
			const opened = await decryptEnvelope(file.envelope, derived.key);
			if (!run.isCurrent()) return;
			if (!opened.ok) {
				this.#failInput(run, opened.code);
				return;
			}
			stage = 'content';
			const checked = validateInner(opened.inner);
			if (!checked.ok) {
				this.#failInput(run, checked.code);
				return;
			}

			if (session.kind === 'check') {
				const summary = summarize(checked.inner, file.label);
				this.#checked = { line: checkOpensLine(summary.madeOn), summary };
				run.enter('done');
				return;
			}
			await this.#confirmFrom(run, checked.inner, file.label, null);
		} catch (e) {
			if (e instanceof RunAbortedError) return;
			run.toPre(toBackupCode(e, stage));
		} finally {
			run.release();
			this.#notify();
		}
	}

	/** The one device read, then the confirm. Used for the first confirm and again after the device moved. */
	async #confirmFrom(
		run: Run,
		inner: ValidInner,
		label: string | null,
		notice: BackupCode | null
	): Promise<void> {
		const db = this.#db;
		if (db === null) {
			run.toPre('E_BACKUP_UNAVAILABLE');
			return;
		}
		let device: Awaited<ReturnType<NonNullable<FlowDeps['readDevice']>>>;
		try {
			device = await this.#readDevice(db);
		} catch (e) {
			if (!run.isCurrent()) return;
			this.#failDevice(run, deviceReadCode(e));
			return;
		}
		if (!run.isCurrent()) return;
		// Setup always signs a profile mark, so none at all is damage. The writer refuses it at Replace; say so now
		// instead of showing "no saved data yet" over a device the app itself would call damaged.
		if (device.state.ts.profile === null) {
			this.#failDevice(run, 'E_RESTORE_DEVICE_DAMAGED');
			return;
		}
		const described = describeDevice(device.state, inner.createdAt);
		const confirm: ConfirmHold = {
			gens: device.state.gens,
			installUuid: device.installUuid,
			summary: summarize(inner, label),
			deviceLine: described.line,
			warning: described.warning,
			notice
		};
		run.hold('confirm', confirm);
		run.enter('confirm');
	}

	/** Replace. Opens and checks the held file again, then writes in one step. */
	async replace(): Promise<void> {
		const session = this.#session;
		if (session.kind !== 'restore' || session.phase !== 'confirm') return;
		const confirm = this.confirm;
		// Nothing to compare the device against yet: there is nothing to press.
		if (confirm === null) return;
		const db = this.#db;
		const file = this.#heldFile();
		const key = session.held('key');
		if (db === null || file === null || !(key instanceof CryptoKey)) return;
		const run = session.beginRun();
		if (run === null) return;
		let stage: 'crypto' | 'content' = 'crypto';
		try {
			if (!run.enter('writing')) return;
			const opened = await decryptEnvelope(file.envelope, key);
			if (!run.isCurrent()) return;
			if (!opened.ok) {
				this.#failInput(run, opened.code);
				return;
			}
			stage = 'content';
			const checked = validateInner(opened.inner);
			if (!checked.ok) {
				this.#failInput(run, checked.code);
				return;
			}

			// Awaited directly: once the writer has committed, nothing may drop what comes after it.
			const result = await restoreBackup(
				db,
				checked.inner,
				{ gens: confirm.gens, installUuid: confirm.installUuid },
				{
					signal: run.signal,
					mayCommit: run.mayCommit,
					onCommitting: session.markCommitting
				}
			);
			if (result.ok) {
				this.#afterCommit();
				return;
			}
			await this.#afterRefusal(run, result.code, checked.inner, file.label);
		} catch (e) {
			if (e instanceof RunAbortedError) return;
			run.toPre(toBackupCode(e, stage));
		} finally {
			run.release();
			this.#notify();
		}
	}

	async #afterRefusal(
		run: Run,
		code: RestoreFailureCode,
		inner: ValidInner,
		label: string | null
	): Promise<void> {
		switch (code) {
			case 'E_RESTORE_DEVICE_MOVED':
				// Back to the checking step with fresh counts; the same held file is used again.
				if (!run.enter('decrypting')) return;
				await this.#confirmFrom(run, inner, label, 'E_RESTORE_DEVICE_MOVED');
				return;
			case 'E_WRITE_FAILED':
				// One transaction: a failure means nothing was written. The session applies what the person did during the
				// commit window (a lock, an app switch, the page leaving); otherwise they are back at the file step.
				if (this.#session.abortCommit()) run.toPre('E_WRITE_FAILED');
				return;
			default:
				this.#failDevice(run, code);
		}
	}

	/** Written. In the writer promise's own continuation, so no abort can drop any of it. */
	#afterCommit(): void {
		const session = this.#session;
		session.enterPhase('committed');
		try {
			this.#app.publish?.({ type: 'data-replaced' });
		} catch {
			/* the other tabs learn on their next read; this tab's own result still shows */
		}
		this.#decideAfter();
		this.#notify();
	}

	/**
	 * Where the restoring tab goes next. A tab nobody locked meanwhile reloads onto the Timeline; a tab that was locked
	 * stays locked and says so (a returning user unlocks, a first-run tab has no lock screen and is told to reload).
	 * Decided again when the page becomes visible, because a lock can arrive while it waits.
	 */
	#decideAfter(): void {
		this.#stopWaiting?.();
		this.#stopWaiting = null;
		const session = this.#session;
		if (isLockReason(session.epochMovedBy)) {
			if (this.#app.store?.locked === true) {
				this.#app.reloadOnUnlock = true;
				this.#after = 'unlock';
			} else {
				this.#after = 'reload';
			}
			this.#notify();
			return;
		}
		this.#after = 'reloading';
		if (this.#isVisible()) this.#goToTimeline();
		else this.#stopWaiting = this.#onceVisible(() => this.#decideAfter());
		this.#notify();
	}

	/**
	 * Reload with the restored note in the history entry and the address on the Timeline. A replace would drop the note,
	 * so it is only the fallback for a browser that refuses the history write; the address must still leave the setup
	 * screen, or its form could save over the restored date.
	 */
	#goToTimeline(): void {
		const path = this.#timelinePath();
		try {
			markBackupIntent('restored', path);
		} catch {
			this.#replace(path);
			return;
		}
		this.#reload();
	}

	/** The Reload button of a first-run tab that was locked while it restored. */
	reloadNow(): void {
		this.#goToTimeline();
	}

	/** "Erase this device's data" on the damaged-device line: the host opens its Erase dialog. */
	requestErase(): void {
		this.#session.requestErase();
	}

	/** Closes the row, or the result. */
	close(): void {
		this.#session.end();
	}

	// ---- failures --------------------------------------------------------------------------------------------------

	#clearMarks(): void {
		this.#position = null;
		this.#numbers = false;
		this.#offerNewBackup = false;
		this.#offerErase = false;
	}

	/** The person's input failed: back to the file step with the typed words kept, and the field takes focus. */
	#failInput(run: Run, code: BackupCode): void {
		this.#focus += 1;
		if (code === 'E_WRONG_PASSPHRASE' && this.#session.kind === 'check')
			this.#offerNewBackup = true;
		run.toPre(code);
	}

	#failDevice(run: Run, code: BackupCode): void {
		this.#offerErase = code === 'E_RESTORE_DEVICE_DAMAGED';
		run.toPre(code);
	}
}
