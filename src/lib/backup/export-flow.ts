import { downloadTextFile } from '../calendar/download';
import { RunAbortedError } from '../db/locks';
import { safeLog } from '../log/safelog';
import { OccConflictError, type ProfileStore } from '../profile/store.svelte';
import type { BackupCode } from './codes';
import { decryptEnvelope, newBackupSalt, readBackupFile, sealEnvelope } from './envelope';
import { buildExportInner } from './export-inner';
import { compareTypedBack, type PhrasePosition } from './phrase';
import { BACKUP_DEADLINE_MS, untilAborted, type BackupSession, type Run } from './session.svelte';
import { takeSnapshot } from './snapshot';
import { validateInner, type RefusedStore } from './validate';

/**
 * Making a backup, from the moment the person submits the typed-back words to the line they read at the end.
 *
 * The order is fixed by what the browser and the session allow:
 *   - the save place is asked for in the submit itself, before any await, because a browser lets a page open its file
 *     picker only right after the tap;
 *   - the key is derived from the TYPED words, the data is read and sealed, and the sealed text is opened again in
 *     memory before anything is written, so a file that would not open is never written;
 *   - entering `saved` is the commit: it happens in the same synchronous block as the `close()` call (or the download
 *     click), and from there the session has already dropped the words, the key and every plaintext buffer.
 * Nothing here holds a word, a field value, a byte of the file or a record in a message, a log or a result: a failure
 * is a code, and the card looks up its words in copy.ts.
 */

/** What the browser's file-saving API gives the flow; only the parts it uses. */
export type SaveWritable = {
	write: (data: string) => Promise<void>;
	close: () => Promise<void>;
	abort: () => Promise<void>;
};

export type SaveHandle = {
	readonly name?: string;
	getFile: () => Promise<{ size: number; arrayBuffer: () => Promise<ArrayBuffer> }>;
	createWritable: () => Promise<SaveWritable>;
};

export type SavePicker = (options: {
	suggestedName: string;
	types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveHandle>;

export type ExportDeps = {
	session: BackupSession;
	db: IDBDatabase;
	profile: Pick<ProfileStore, 'save' | 'lockState'>;
	/** The browser's save picker, or null where there is none (the file is then downloaded). */
	getSavePicker?: () => SavePicker | null;
	download?: (fileName: string, text: string) => void;
	/** How long the read-back of the saved file may take before the result says it was not checked. */
	readBackMs?: number;
};

/**
 * What the card shows after a call. `stopped` means the session ended the run and already holds the reason (a hide,
 * the deadline, Cancel); the others carry their own code.
 */
export type ExportResult =
	| { kind: 'ignored' }
	| {
			kind: 'invalid';
			code: 'E_WORD_COUNT' | 'E_NOT_LETTERS' | 'E_TYPE_BACK_MISMATCH';
			position?: PhrasePosition;
			numbers?: boolean;
	  }
	| { kind: 'cancelled' }
	| { kind: 'replace-warning'; fileName: string }
	| { kind: 'stopped' }
	| {
			kind: 'failed';
			code: BackupCode;
			position?: PhrasePosition;
			store?: RefusedStore;
			taskId?: string;
	  }
	| {
			kind: 'saved';
			fileName: string;
			readBack: 'matches' | 'mismatch' | 'not-checked' | 'download';
	  };

type Gens = { profile: number; timeline: number; calendar: number };

type Prepared = { text: string; gens: Gens; backupAt: number; fileName: string };

type Pending = { run: Run; pass: Uint8Array<ArrayBuffer>; handle: SaveHandle };

const STOPPED: ExportResult = { kind: 'stopped' };

const PICKER_TYPES = [{ description: 'Ask 214 backup', accept: { 'application/json': ['.json'] } }];

function defaultSavePicker(): SavePicker | null {
	const picker = (window as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
	return typeof picker === 'function' ? picker.bind(window) : null;
}

function isPickerCancel(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

/** An abort of a stream nobody will use again; one that rejects or throws is nothing the person can act on. */
function abortQuietly(writable: SaveWritable): void {
	try {
		void Promise.resolve(writable.abort()).catch(() => {});
	} catch {
		/* the stream is already gone */
	}
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
	return true;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('E_TOOK_TOO_LONG')), ms);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

export class ExportFlow {
	#deps: ExportDeps;
	#pending: Pending | null = null;

	constructor(deps: ExportDeps) {
		this.#deps = deps;
	}

	/**
	 * The type-back form's submit. Everything up to the picker call is synchronous: the check of the typed words, the
	 * run, and the picker. A second submit while a run is going finds the form's phase gone (and the session busy) and
	 * does nothing.
	 */
	submit(event: { preventDefault: () => void }, typed: string): Promise<ExportResult> {
		event.preventDefault();
		const session = this.#deps.session;
		const names = session.names;
		const words = session.words;
		if (
			session.kind !== 'export' ||
			session.concealed ||
			words === null ||
			names === null ||
			(session.phase !== 'phrase-shown' && session.phase !== 'typed-back')
		) {
			return Promise.resolve({ kind: 'ignored' });
		}
		const typedBack = compareTypedBack(typed, words);
		if (!typedBack.ok) {
			if (typedBack.code === 'E_WORD_COUNT') {
				return Promise.resolve({
					kind: 'invalid',
					code: typedBack.code,
					numbers: typedBack.numbers
				});
			}
			return Promise.resolve({
				kind: 'invalid',
				code: typedBack.code,
				position: typedBack.position
			});
		}
		const run = session.beginRun();
		if (run === null) {
			typedBack.bytes.fill(0);
			return Promise.resolve({ kind: 'ignored' });
		}
		// Owned by the run, so a stop or the commit wipes it wherever the flow is waiting.
		run.own(typedBack.bytes);
		const picking = this.#openPicker(names.fileName);
		if (picking !== null) run.enter('picking-save');
		return this.#guard(run, async () => {
			let handle: SaveHandle | null = null;
			if (picking !== null) {
				const picked = await this.#awaitPick(run, picking, 'typed-back');
				if ('result' in picked) return picked.result;
				handle = picked.handle;
				const gate = await this.#checkTarget(run, typedBack.bytes, handle);
				if (gate !== null) return gate;
			}
			return this.#carryOn(run, typedBack.bytes, handle);
		});
	}

	/** "Replace it" on the warning for a file that already holds something. */
	replace(): Promise<ExportResult> {
		const pending = this.#pending;
		if (pending === null) return Promise.resolve({ kind: 'ignored' });
		const { run, pass, handle } = pending;
		if (!run.isCurrent() || this.#deps.session.phase !== 'replace-warning') {
			this.#pending = null;
			run.release();
			return Promise.resolve(STOPPED);
		}
		this.#pending = null;
		return this.#guard(run, () => this.#carryOn(run, pass, handle));
	}

	/** "Choose another place" on that warning: a fresh picker, opened from this click. */
	chooseAnother(): Promise<ExportResult> {
		const pending = this.#pending;
		const names = this.#deps.session.names;
		if (
			pending === null ||
			names === null ||
			!pending.run.isCurrent() ||
			this.#deps.session.phase !== 'replace-warning'
		) {
			return Promise.resolve({ kind: 'ignored' });
		}
		const { run, pass } = pending;
		const picking = this.#openPicker(names.fileName);
		if (picking === null) return Promise.resolve({ kind: 'ignored' });
		const previous = pending.handle;
		run.enter('picking-save');
		this.#pending = null;
		return this.#guard(run, async () => {
			const picked = await this.#awaitPick(run, picking, 'replace-warning');
			if ('result' in picked) {
				// The person backed out of the second picker: the first file is still the one on offer.
				if (picked.result.kind !== 'cancelled') return picked.result;
				this.#pending = { run, pass, handle: previous };
				return { kind: 'replace-warning', fileName: previous.name ?? names.fileName };
			}
			const gate = await this.#checkTarget(run, pass, picked.handle);
			return gate ?? this.#carryOn(run, pass, picked.handle);
		});
	}

	/** Runs the work, then ends the run unless the person is being asked something. Nothing escapes as a throw. */
	async #guard(run: Run, work: () => Promise<ExportResult>): Promise<ExportResult> {
		let result: ExportResult;
		try {
			result = await work();
		} catch (error) {
			result = this.#stop(run, error instanceof RunAbortedError ? null : 'E_SAVE_FAILED');
		}
		if (result.kind !== 'replace-warning') run.release();
		return result;
	}

	/** Back to the last waiting phase with `code` shown, or just "stopped" when the session already ended the run. */
	#stop(run: Run, code: BackupCode | null, extra: Partial<ExportResult> = {}): ExportResult {
		if (code === null || !run.toPre(code)) return STOPPED;
		return { ...extra, kind: 'failed', code };
	}

	#openPicker(suggestedName: string): Promise<SaveHandle> | null {
		const picker = (this.#deps.getSavePicker ?? defaultSavePicker)();
		if (picker === null) return null;
		try {
			return picker({ suggestedName, types: PICKER_TYPES });
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async #awaitPick(
		run: Run,
		picking: Promise<SaveHandle>,
		back: 'typed-back' | 'replace-warning'
	): Promise<{ handle: SaveHandle } | { result: ExportResult }> {
		try {
			const handle = await untilAborted(picking, run.signal);
			if (!run.hold('saveHandle', handle)) return { result: STOPPED };
			run.enter('save-chosen');
			return { handle };
		} catch (error) {
			if (error instanceof RunAbortedError) return { result: STOPPED };
			if (isPickerCancel(error)) {
				run.enter(back);
				return { result: { kind: 'cancelled' } };
			}
			return { result: this.#stop(run, 'E_SAVE_FAILED') };
		}
	}

	/** The warning for a file that already holds something, or null when the place is free to write. */
	async #checkTarget(
		run: Run,
		pass: Uint8Array<ArrayBuffer>,
		handle: SaveHandle
	): Promise<ExportResult | null> {
		let size: number;
		try {
			// Metadata only: a File's size needs no read of its content.
			size = (await untilAborted(handle.getFile(), run.signal)).size;
		} catch (error) {
			return this.#stop(run, error instanceof RunAbortedError ? null : 'E_SAVE_FAILED');
		}
		if (size === 0) return null;
		if (!run.enter('replace-warning')) return STOPPED;
		this.#pending = { run, pass, handle };
		return { kind: 'replace-warning', fileName: this.#nameOf(handle) };
	}

	#nameOf(handle: SaveHandle | null): string {
		const chosen = handle?.name;
		return typeof chosen === 'string' && chosen !== ''
			? chosen
			: (this.#deps.session.names?.fileName ?? '');
	}

	/** From the key to the end: seal and check the file in memory, write it, commit, mark the device, read it back. */
	async #carryOn(
		run: Run,
		pass: Uint8Array<ArrayBuffer>,
		handle: SaveHandle | null
	): Promise<ExportResult> {
		const prepared = await this.#prepare(run, pass);
		if ('kind' in prepared) return prepared;
		if (handle === null) return this.#download(run, prepared);
		return this.#writeFile(run, handle, prepared);
	}

	/**
	 * Derive, read, seal, and open the sealed text again. It returns the text and nothing secret: the key and the
	 * plaintext stay inside, held by the run so a stop or the commit wipes them.
	 */
	async #prepare(run: Run, pass: Uint8Array<ArrayBuffer>): Promise<Prepared | ExportResult> {
		const session = this.#deps.session;
		const backupAt = session.backupAt;
		const names = session.names;
		if (backupAt === null || names === null) return STOPPED;

		const salt = newBackupSalt();
		const derived = await session.derive(run, { purpose: 'export', pass: pass.buffer, salt });
		if (!derived.ok) {
			return this.#stop(
				run,
				derived.code,
				derived.position === undefined ? {} : { position: derived.position }
			);
		}

		// One deadline from here to the close() call.
		if (!run.enter('snapshot')) return STOPPED;
		// Awaited to the end, never raced: what it decodes has to be wiped even when the run was stopped meanwhile.
		const snap = await takeSnapshot(this.#deps.db, run.signal);
		if (!snap.ok) {
			return this.#stop(
				run,
				snap.code,
				snap.code === 'E_SNAPSHOT_FAILED' ? { store: snap.store } : {}
			);
		}
		if (!run.ownRecord(snap.profile as unknown as Record<string, unknown>)) return STOPPED;

		if (!run.enter('encrypting')) return STOPPED;
		const built = buildExportInner(snap, backupAt);
		if (!built.ok) {
			if (built.code === 'E_CONTENT_TOO_LARGE') {
				return this.#stop(run, built.code, { taskId: built.taskId });
			}
			return this.#stop(run, built.code, { store: built.store });
		}
		if (!run.own(built.bytes)) return STOPPED;
		const text = await sealEnvelope(derived.key, built.bytes, salt);
		if (!run.enter('verifying')) return STOPPED;
		const opens = await this.#opensAgain(text, derived.key, built.bytes, names.fileName);
		// A file that cannot be opened here is never written: nothing has left memory yet.
		if (!opens) return this.#stop(run, 'E_CRYPTO_FAILED');
		if (!run.isCurrent()) return STOPPED;
		return { text, gens: snap.gens, backupAt, fileName: names.fileName };
	}

	/** The sealed text goes back through the restore path with the key in hand and must give the content it was made of. */
	async #opensAgain(
		text: string,
		key: CryptoKey,
		sealed: Uint8Array,
		fileName: string
	): Promise<boolean> {
		try {
			const read = await readBackupFile(new File([text], fileName));
			if (!read.ok) return false;
			const opened = await decryptEnvelope(read.envelope, key);
			if (!opened.ok) return false;
			const checked = validateInner(opened.inner);
			if (!checked.ok) return false;
			const again = new TextEncoder().encode(JSON.stringify(checked.inner));
			try {
				return sameBytes(again, sealed);
			} finally {
				again.fill(0);
			}
		} catch {
			return false;
		}
	}

	async #download(run: Run, prepared: Prepared): Promise<ExportResult> {
		if (!run.enter('writing')) return STOPPED;
		try {
			(this.#deps.download ?? defaultDownload)(prepared.fileName, prepared.text);
		} catch {
			return this.#stop(run, 'E_SAVE_FAILED');
		}
		// The click is synchronous and cannot be taken back: committed from here.
		run.enter('saved');
		await this.#markBackup(run, prepared);
		run.enter('done');
		return { kind: 'saved', fileName: prepared.fileName, readBack: 'download' };
	}

	async #writeFile(run: Run, handle: SaveHandle, prepared: Prepared): Promise<ExportResult> {
		if (!run.enter('writing')) return STOPPED;
		// Awaited to the end: a stream opened after the run was stopped still has to be aborted.
		const writable = await handle.createWritable();
		if (!run.hold('writable', writable)) {
			abortQuietly(writable);
			return STOPPED;
		}
		// The session aborts the held stream on any stop, so a failure here leaves the old file as it was.
		await untilAborted(writable.write(prepared.text), run.signal);

		// The commit point. `saved` is entered in the same synchronous block as the close() call, so nothing can stop the
		// run between the two; if the run is already stopped, nothing is closed.
		if (!run.enter('saved')) {
			abortQuietly(writable);
			return STOPPED;
		}
		let closing: Promise<void>;
		try {
			closing = Promise.resolve(writable.close());
		} catch (error) {
			closing = Promise.reject(error);
		}
		const fileName = this.#nameOf(handle);
		try {
			// Never raced: close() is what makes the file exist, and the session cannot take it back.
			await closing;
		} catch {
			// Nothing is on the device, and the words are already gone, so the session ends here.
			run.enter('done');
			return { kind: 'failed', code: 'E_SAVE_FAILED' };
		}
		await this.#markBackup(run, prepared);
		run.enter('checking');
		const readBack = await this.#readBack(handle, prepared.text);
		run.enter('done');
		return { kind: 'saved', fileName, readBack };
	}

	/**
	 * Records "Last backup" and which saved states the file matches. It never depends on the read-back and never fails
	 * the backup: the file already exists. A refusal (another tab saved the profile since the snapshot) just leaves the
	 * older date.
	 */
	async #markBackup(run: Run, prepared: Prepared): Promise<void> {
		// A store that a hide or a lock evicted would refuse the save as a conflict that never was one, and loading it
		// again is not this flow's to do: the older date stays and the restore warning falls back to its time rule.
		if (!run.isCurrent() || this.#deps.profile.lockState !== 'unlocked') return;
		const { gens, backupAt } = prepared;
		try {
			await this.#deps.profile.save({
				lastBackupAt: backupAt,
				backupGenProfile: gens.profile + 1,
				backupGenTimeline: gens.timeline,
				backupGenCalendar: gens.calendar
			});
		} catch (error) {
			safeLog({ code: error instanceof OccConflictError ? 'E_OCC_CONFLICT' : 'E_INTERNAL' });
		}
	}

	async #readBack(
		handle: SaveHandle,
		text: string
	): Promise<'matches' | 'mismatch' | 'not-checked'> {
		const moved = this.#deps.session.epochMovedBy;
		// The person left the page: the file is saved, and nobody is there to read the answer.
		if (moved === 'pagehide' || moved === 'navigated') return 'not-checked';
		try {
			return await withTimeout(
				this.#compareFile(handle, text),
				this.#deps.readBackMs ?? BACKUP_DEADLINE_MS
			);
		} catch {
			return 'not-checked';
		}
	}

	async #compareFile(handle: SaveHandle, text: string): Promise<'matches' | 'mismatch'> {
		const expected = new TextEncoder().encode(text);
		const file = await handle.getFile();
		// The size first: a swapped-in huge file is never read into memory.
		if (file.size !== expected.length) return 'mismatch';
		return sameBytes(new Uint8Array(await file.arrayBuffer()), expected) ? 'matches' : 'mismatch';
	}
}

function defaultDownload(fileName: string, text: string): void {
	downloadTextFile(fileName, 'application/json', text);
}
