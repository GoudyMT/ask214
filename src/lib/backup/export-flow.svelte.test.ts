import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { withStores } from '../db/schema';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { getDiagnosticsForTest } from '../log/safelog';
import { createCalendarSyncStore } from '../calendar/store.svelte';
import { createJoinRelock, relockEachSync, type Relockable } from '../profile/app-init';
import type { RelockReason } from '../profile/lifecycle';
import { createProfileStore, readDeviceState, type ProfileStore } from '../profile/store.svelte';
import { createTimelineStateStore } from '../timeline/state.svelte';
import { decryptEnvelope, readBackupFile } from './envelope';
import {
	ExportFlow,
	type ExportDeps,
	type ExportResult,
	type SaveHandle,
	type SavePicker,
	type SaveWritable
} from './export-flow';
import { canonicalizePhrase } from './phrase';
import { BackupSession, type StartApp, type WorkerLike } from './session.svelte';
import { validateInner } from './validate';
import type { FromWorker, WorkerRequest } from './worker/protocol';

// The flow is driven the way the card will drive it: a fake save handle, a fake key worker through the session's own
// seam, and a real IndexedDB with the real stores for the snapshot and the "Last backup" save. The wrappers below
// only watch the seams a person cannot see (what was wiped, what was sealed) or hold one step still.
const seams = vi.hoisted(() => ({
	typed: [] as Uint8Array[],
	sealed: [] as Uint8Array[],
	seal: 'ok' as 'ok' | 'flip' | 'otherKey' | 'otherBytes',
	snapEaos: null as Uint8Array | null,
	afterSnapshot: null as (() => Promise<void>) | null
}));

vi.mock('$lib/backup/phrase', async (importOriginal) => {
	const real = await importOriginal<typeof import('./phrase')>();
	return {
		...real,
		compareTypedBack: (...args: Parameters<typeof real.compareTypedBack>) => {
			const result = real.compareTypedBack(...args);
			if (result.ok) seams.typed.push(result.bytes);
			return result;
		}
	};
});

vi.mock('$lib/backup/envelope', async (importOriginal) => {
	const real = await importOriginal<typeof import('./envelope')>();
	return {
		...real,
		sealEnvelope: async (...args: Parameters<typeof real.sealEnvelope>) => {
			const [key, inner, salt] = args;
			seams.sealed.push(inner);
			if (seams.seal === 'otherKey') {
				// A file that parses and checks out but whose key is not the one the person's words make.
				const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
					'encrypt',
					'decrypt'
				]);
				return real.sealEnvelope(other, inner, salt);
			}
			if (seams.seal === 'otherBytes') {
				// A file that opens with the right key and holds a valid backup, but not the one that was made.
				const changed = JSON.parse(new TextDecoder().decode(inner)) as { createdAt: number };
				changed.createdAt += 1;
				return real.sealEnvelope(key, new TextEncoder().encode(JSON.stringify(changed)), salt);
			}
			const text = await real.sealEnvelope(...args);
			if (seams.seal !== 'flip') return text;
			// One flipped character of the ciphertext: the file's own check no longer matches.
			const file = JSON.parse(text) as { data: string };
			file.data = (file.data.startsWith('A') ? 'B' : 'A') + file.data.slice(1);
			return JSON.stringify(file);
		}
	};
});

vi.mock('$lib/backup/snapshot', async (importOriginal) => {
	const real = await importOriginal<typeof import('./snapshot')>();
	return {
		...real,
		takeSnapshot: async (...args: Parameters<typeof real.takeSnapshot>) => {
			const snap = await real.takeSnapshot(...args);
			// The record the flow is handed: the validator wipes records of its own, which must not stand in for it.
			if (snap.ok) seams.snapEaos = snap.profile.eaos as Uint8Array;
			await seams.afterSnapshot?.();
			return snap;
		}
	};
});

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };

function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const WORDS = ['bamboo', 'copper', 'harvest', 'lantern', 'oxygen', 'thimble'];
const TYPED = 'bamboo copper harvest lantern oxygen thimble';
const APP: StartApp = { status: 'ready', joinRelock: () => () => {}, publish: () => {} };

// Stands in for the Argon2id worker, whose cost (128 MiB) has no place in a flow test: the key is a pure function of
// the posted passphrase bytes and salt, so the same words open the file and any other words do not.
async function keyFor(pass: ArrayBuffer, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey('raw', pass, 'PBKDF2', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt, iterations: 1, hash: 'SHA-256' },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

const kdf = { reply: null as FromWorker | null };

class FakeKeyWorker implements WorkerLike {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessageerror: ((event: unknown) => void) | null = null;

	postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
		// A real transfer: the page's buffer is detached the moment it is posted.
		const sent = transfer.length > 0 ? structuredClone(message, { transfer }) : message;
		void this.#answer(sent);
	}
	terminate(): void {}

	async #answer(message: WorkerRequest): Promise<void> {
		if (message.op === 'generate') {
			this.onmessage?.({ data: { type: 'words', words: WORDS } });
			return;
		}
		if (kdf.reply !== null) {
			this.onmessage?.({ data: kdf.reply });
			return;
		}
		const key = await keyFor(message.pass, message.salt);
		this.onmessage?.({ data: { type: 'key', key } });
	}
}

/** A file the person picked: what it holds now, and every call made on it. */
function fakeFile(over: { existing?: string; name?: string } = {}) {
	const f = {
		name: over.name ?? 'picked.json',
		content: over.existing ?? '',
		staged: null as string | null,
		created: 0,
		writes: 0,
		closes: 0,
		aborts: 0,
		reads: 0,
		createGate: null as Deferred<void> | null,
		writeGate: null as Deferred<void> | null,
		closeGate: null as Deferred<void> | null,
		onClose: null as (() => void | Promise<void>) | null,
		failClose: false,
		mangle: false,
		readBack: 'ok' as 'ok' | 'reject' | 'hang',
		handle: null as unknown as SaveHandle
	};
	const writable: SaveWritable = {
		write: async (data) => {
			f.writes += 1;
			await f.writeGate?.promise;
			f.staged = data;
		},
		close: async () => {
			f.closes += 1;
			await f.onClose?.();
			await f.closeGate?.promise;
			if (f.failClose) throw new Error('E_TEST');
			f.content = (f.staged ?? '') + (f.mangle ? ' ' : '');
		},
		abort: () => {
			f.aborts += 1;
			f.staged = null;
			return Promise.resolve();
		}
	};
	f.handle = {
		name: f.name,
		getFile: () => {
			f.reads += 1;
			// The first read is the check for an existing file; a later one is the read-back.
			if (f.reads > 1 && f.readBack === 'reject') return Promise.reject(new Error('E_TEST'));
			if (f.reads > 1 && f.readBack === 'hang') return new Promise(() => {});
			return Promise.resolve(new File([f.content], f.name));
		},
		createWritable: async () => {
			f.created += 1;
			await f.createGate?.promise;
			return writable;
		}
	};
	return f;
}

function pickerOf(...answers: (SaveHandle | Error)[]) {
	const queue = [...answers];
	return vi.fn<SavePicker>(() => {
		const next = queue.shift();
		if (next === undefined) return Promise.reject(new Error('E_TEST_NO_ANSWER'));
		return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
	});
}

/** What the promise gives, or 'hung' when it has not settled in time: a hang then fails an assertion, not the suite's clock. */
const within = <T>(work: Promise<T>, ms = 500) =>
	Promise.race([work, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), ms))]);

const cancelled = () => new DOMException('The user aborted a request.', 'AbortError');

let db: IDBDatabase;
let profile: ProfileStore;
const sessions: BackupSession[] = [];

beforeEach(async () => {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	profile = createProfileStore(db);
	await profile.save({ eaos: new TextEncoder().encode('2027-04-15'), setupIntent: 'completed' });
	seams.typed.length = 0;
	seams.sealed.length = 0;
	seams.seal = 'ok';
	seams.snapEaos = null;
	seams.afterSnapshot = null;
	kdf.reply = null;
});

afterEach(async () => {
	for (const session of sessions.splice(0)) session.relockSync('user');
	await deleteTestDb(db);
});

/** An export session at the type-back form, and a flow over it. */
async function rig(picker: SavePicker | null, extra: Partial<ExportDeps> = {}) {
	const workers: FakeKeyWorker[] = [];
	// One relock list, as the layout builds it: the profile store sits in it and the session joins through the same
	// seam, so a hide reaches both the way it does in the app.
	const relockables: Relockable[] = [];
	const joinRelock = createJoinRelock(relockables);
	joinRelock({
		relockSync: (reason) => profile.relockSync(reason),
		refresh: () => Promise.resolve()
	});
	const session = new BackupSession({
		isVisible: () => true,
		hasFocus: () => true,
		createWorker: () => {
			const worker = new FakeKeyWorker();
			workers.push(worker);
			return worker;
		}
	});
	sessions.push(session);
	session.start({ ...APP, joinRelock }, 'export');
	await session.showPassphrase();
	session.enterPhase('typed-back');
	const flow = new ExportFlow({ session, db, profile, getSavePicker: () => picker, ...extra });
	const relock = (reason: RelockReason) => relockEachSync(relockables, reason);
	return { session, workers, flow, relock };
}

const submit = (flow: ExportFlow, typed = TYPED) => flow.submit({ preventDefault: vi.fn() }, typed);

const SAVED: ExportResult = { kind: 'saved', fileName: 'picked.json', readBack: 'matches' };

describe('the save picker and the type-back', () => {
	// The browser lets a page open its picker only right after the tap, so a single await before the call loses it.
	it('the save picker is called before the first await of the type-back submit', async () => {
		const f = fakeFile();
		const picker = pickerOf(f.handle);
		const { session, flow } = await rig(picker);
		const event = { preventDefault: vi.fn() };

		const pending = flow.submit(event, TYPED);
		expect(picker).toHaveBeenCalledTimes(1);
		expect(picker).toHaveBeenCalledWith(
			expect.objectContaining({ suggestedName: session.names?.fileName })
		);
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(session.phase).toBe('picking-save');
		expect(session.busy).toBe(true);
		await pending;
	});

	// A typo in the words must be caught before a file dialog opens and before any key work.
	it.each([
		['a wrong last word', 'bamboo copper harvest lantern oxygen thimbl', 6, undefined],
		['a letter that is a digit', 'bamboo copper harvest lan7ern oxygen thimble', 4, undefined],
		[
			'numbers in front of the words',
			'1 bamboo copper harvest lantern oxygen thimble',
			undefined,
			true
		]
	])('a wrong type-back opens no picker: %s', async (_name, typed, position, numbers) => {
		const picker = pickerOf(fakeFile().handle);
		const { session, workers, flow } = await rig(picker);

		const result = await submit(flow, typed);

		expect(result).toEqual(
			numbers === true
				? { kind: 'invalid', code: 'E_WORD_COUNT', numbers: true }
				: {
						kind: 'invalid',
						code: position === 4 ? 'E_NOT_LETTERS' : 'E_TYPE_BACK_MISMATCH',
						position
					}
		);
		expect(picker).not.toHaveBeenCalled();
		expect(workers).toHaveLength(1);
		expect(session.busy).toBe(false);
		expect(session.phase).toBe('typed-back');
	});

	// A held Enter or a second tap must not open two dialogs or derive the key twice, with or without a picker.
	it.each([true, false])(
		'a double click opens one picker and starts one worker (picker: %s)',
		async (hasPicker) => {
			const f = fakeFile();
			const picker = hasPicker ? pickerOf(f.handle) : null;
			const download = vi.fn();
			const { workers, flow } = await rig(picker, { download });
			const afterShow = workers.length;

			const first = submit(flow);
			const second = submit(flow);

			expect(await second).toEqual({ kind: 'ignored' });
			expect((await first).kind).toBe('saved');
			expect(picker?.mock.calls.length ?? 0).toBe(hasPicker ? 1 : 0);
			expect(download).toHaveBeenCalledTimes(hasPicker ? 0 : 1);
			expect(workers.length - afterShow).toBe(1);
		}
	);

	// A stray submit (autofill, a held key) after the form is gone must not open a dialog for a session that ended.
	it.each([
		['after Cancel cleared the session', (s: BackupSession) => s.cancel()],
		[
			'while the app is hidden',
			(_s: BackupSession, relock: (r: RelockReason) => void) => relock('hygiene')
		]
	])('a submit %s does nothing', async (_name, away) => {
		const picker = pickerOf(fakeFile().handle);
		const { session, flow, relock } = await rig(picker);
		away(session, relock);

		expect(await submit(flow)).toEqual({ kind: 'ignored' });
		expect(picker).not.toHaveBeenCalled();
	});

	it('backing out of the picker returns to the form silently with the words kept', async () => {
		const picker = pickerOf(cancelled());
		const { session, workers, flow } = await rig(picker);

		expect(await submit(flow)).toEqual({ kind: 'cancelled' });

		expect(session.phase).toBe('typed-back');
		expect(session.busy).toBe(false);
		expect(session.message).toBeNull();
		expect(session.words).not.toBeNull();
		expect(workers).toHaveLength(1);
	});

	it('a picker that fails for another reason says nothing was saved', async () => {
		const picker = pickerOf(new DOMException('blocked', 'SecurityError'));
		const { session, flow } = await rig(picker);

		expect(await submit(flow)).toEqual({ kind: 'failed', code: 'E_SAVE_FAILED' });

		expect(session.message).toBe('E_SAVE_FAILED');
		expect(session.phase).toBe('typed-back');
		expect(session.busy).toBe(false);
	});
});

describe('replacing a file that already holds something', () => {
	// An old backup picked by mistake is deleted by a save over it, so the person is asked first.
	it('a non-empty file shows the warning and writes nothing until Replace it', async () => {
		const f = fakeFile({ existing: 'an older backup' });
		const { session, workers, flow } = await rig(pickerOf(f.handle));
		const afterShow = workers.length;

		const warned = await submit(flow);

		expect(warned).toEqual({ kind: 'replace-warning', fileName: 'picked.json' });
		expect(session.phase).toBe('replace-warning');
		expect(session.busy).toBe(true);
		expect(f.created).toBe(0);
		expect(workers.length).toBe(afterShow);

		expect(await flow.replace()).toEqual(SAVED);
		expect(f.content).not.toBe('an older backup');
		expect(session.busy).toBe(false);
	});

	it('Choose another place reopens the picker from that click, and a back-out keeps the warning', async () => {
		const old = fakeFile({ existing: 'an older backup', name: 'old.json' });
		const fresh = fakeFile({ name: 'fresh.json' });
		const picker = pickerOf(old.handle, cancelled(), fresh.handle);
		const { session, flow } = await rig(picker);
		await submit(flow);

		const second = flow.chooseAnother();
		expect(picker).toHaveBeenCalledTimes(2);
		expect(await second).toEqual({ kind: 'replace-warning', fileName: 'old.json' });
		expect(session.phase).toBe('replace-warning');

		const third = flow.chooseAnother();
		expect(picker).toHaveBeenCalledTimes(3);
		expect(await third).toEqual({ kind: 'saved', fileName: 'fresh.json', readBack: 'matches' });
		expect(fresh.content).not.toBe('');
		expect(old.content).toBe('an older backup');
		expect(old.created).toBe(0);
	});

	// Cancel at the warning clears the session; the held passphrase goes with it and a late Replace does nothing.
	it('Cancel at the warning wipes the held passphrase and Replace then does nothing', async () => {
		const f = fakeFile({ existing: 'an older backup' });
		const { session, workers, flow } = await rig(pickerOf(f.handle));
		await submit(flow);
		const afterShow = workers.length;
		const typedBytes = seams.typed[0];
		expect(typedBytes?.some((byte) => byte !== 0)).toBe(true);

		expect(session.cancel()).toBe(true);

		expect(typedBytes?.every((byte) => byte === 0)).toBe(true);
		expect(await flow.replace()).toEqual({ kind: 'stopped' });
		expect(workers.length).toBe(afterShow);
		expect(f.created).toBe(0);
		expect(f.content).toBe('an older backup');
		expect(session.busy).toBe(false);
	});
});

describe('a saved file', () => {
	// The point of a backup: the file the person is left with opens with the words they wrote down, and holds their data.
	it('the sealed file opens with the typed words', async () => {
		const timeline = createTimelineStateStore(db);
		await timeline.load();
		await timeline.setStatus('va-gov-account', 'done');
		const f = fakeFile();
		const { session, flow } = await rig(pickerOf(f.handle));

		expect(await submit(flow, '  Bamboo COPPER harvest\tlantern oxygen thimble ')).toEqual(SAVED);

		const read = await readBackupFile(new File([f.content], 'x.json'));
		if (!read.ok) throw new Error('E_TEST_FILE');
		const typed = canonicalizePhrase(TYPED);
		if (!typed.ok) throw new Error('E_TEST_WORDS');
		const key = await keyFor(typed.bytes.buffer, read.envelope.salt);
		const opened = await decryptEnvelope(read.envelope, key);
		if (!opened.ok) throw new Error('E_TEST_OPEN');
		const checked = validateInner(opened.inner);
		if (!checked.ok) throw new Error('E_TEST_VALID');
		expect(checked.inner.createdAt).toBe(session.backupAt);
		expect(checked.inner.stores.profile.setupIntent).toBe('completed');
		expect(checked.inner.stores['timeline-state']?.tasks).toEqual({
			'va-gov-account': { status: 'done' }
		});

		const other = await keyFor(
			new TextEncoder().encode('some other words here now ok').buffer,
			read.envelope.salt
		);
		expect(await decryptEnvelope(read.envelope, other)).toMatchObject({
			ok: false,
			code: 'E_WRONG_PASSPHRASE'
		});
	});

	// "Last backup" and the comparison the restore warning will use: the device still equals what was exported.
	it('export success writes the mark at the generations the snapshot read', async () => {
		// Each store at its own, different generation, so a mark that swapped two of them would show.
		const timeline = createTimelineStateStore(db);
		await timeline.load();
		await timeline.setStatus('va-gov-account', 'done');
		await timeline.setStatus('tap-course', 'skipped');
		const calendar = createCalendarSyncStore(db);
		await calendar.load();
		await calendar.setExclusions({ taskIds: ['job-search'], categories: [] });
		await calendar.setExclusions({ taskIds: ['job-search'], categories: ['finance'] });
		await calendar.setExclusions({ taskIds: [], categories: ['finance'] });
		const before = await readDeviceState(db);
		expect(before.gens).toEqual({ profile: 1, timeline: 2, calendar: 3 });
		expect(before.mark).toBeNull();
		const f = fakeFile();
		const { session, flow } = await rig(pickerOf(f.handle));
		const backupAt = session.backupAt;

		expect(await submit(flow)).toEqual(SAVED);

		const state = await readDeviceState(db);
		expect(state.mark?.at).toBe(backupAt);
		expect(state.mark?.gens).toEqual({ profile: 2, timeline: 2, calendar: 3 });
		expect(state.gens).toEqual(state.mark?.gens);
		expect(session.busy).toBe(false);
	});

	// Another tab saved the profile after the snapshot: the older date stays, and the person still has their file.
	it('an OCC conflict on the mark save still reports the backup saved', async () => {
		const peer = createProfileStore(db);
		await peer.load();
		const f = fakeFile();
		f.onClose = async () => {
			await peer.save({});
		};
		const { flow } = await rig(pickerOf(f.handle));

		expect(await submit(flow)).toEqual(SAVED);

		expect(f.content).not.toBe('');
		expect((await readDeviceState(db)).mark).toBeNull();
		expect(getDiagnosticsForTest().at(-1)?.code).toBe('E_OCC_CONFLICT');
	});

	it('the download fallback commits at the click and shows the downloaded result', async () => {
		const download = vi.fn<(fileName: string, text: string) => void>();
		let phaseAtMark = '';
		let wordsAtMark: readonly string[] | null = WORDS;
		const marking: Pick<ProfileStore, 'save' | 'lockState'> = {
			lockState: 'unlocked',
			save: (patch) => {
				phaseAtMark = session.phase;
				wordsAtMark = session.words;
				return profile.save(patch);
			}
		};
		const { session, flow } = await rig(null, { download, profile: marking });
		let phaseAtClick = '';
		download.mockImplementation(() => {
			phaseAtClick = session.phase;
		});

		const result = await submit(flow);

		expect(result).toEqual({
			kind: 'saved',
			fileName: session.names?.fileName,
			readBack: 'download'
		});
		expect(download).toHaveBeenCalledTimes(1);
		expect(download.mock.calls[0]?.[0]).toBe(session.names?.fileName);
		expect(await readBackupFile(new File([download.mock.calls[0]?.[1] ?? ''], 'x'))).toMatchObject({
			ok: true
		});
		expect(phaseAtClick).toBe('writing');
		expect(phaseAtMark).toBe('saved');
		expect(wordsAtMark).toBeNull();
		expect(session.phase).toBe('done');
		expect((await readDeviceState(db)).mark?.at).toBe(session.backupAt);
	});
});

describe('the commit point', () => {
	// The tap on Save is final the moment close() is called: a hide after that must not turn "saved" into "you left". The
	// hide also evicts the profile, so "Last backup" keeps its older date: skipped quietly, since nothing conflicted.
	it('a hide after close() was called shows the saved line, not LEFT_APP, and leaves the mark alone', async () => {
		const f = fakeFile();
		f.closeGate = deferred();
		const { session, flow, relock } = await rig(pickerOf(f.handle));
		const logged = getDiagnosticsForTest().length;

		const pending = submit(flow);
		await vi.waitFor(() => expect(f.closes).toBe(1));
		expect(session.phase).toBe('saved');
		expect(session.canCancel).toBe(false);
		expect(session.cancel()).toBe(false);
		relock('hygiene');
		f.closeGate.resolve();

		expect(await pending).toEqual(SAVED);
		expect(session.message).toBeNull();
		expect(f.aborts).toBe(0);
		expect((await readDeviceState(db)).mark).toBeNull();
		expect(getDiagnosticsForTest().length).toBe(logged);
	});

	// close() is what makes the file exist; a signal that fires while it runs must not turn a written file into "stopped".
	it('close() is awaited to its end even if the run is aborted meanwhile', async () => {
		const f = fakeFile();
		f.closeGate = deferred();
		const { session, flow } = await rig(pickerOf(f.handle));

		const pending = submit(flow);
		await vi.waitFor(() => expect(f.closes).toBe(1));
		session.abortRun('test');
		f.closeGate.resolve();

		expect((await pending).kind).toBe('saved');
		expect(f.content).not.toBe('');
	});

	// Nothing secret may be left in memory once the file is as good as written; read the state INSIDE the close() call.
	it('the key, words and plaintext are zeroed at the close() call', async () => {
		const f = fakeFile();
		const seen: Record<string, unknown> = {};
		const { session, flow } = await rig(pickerOf(f.handle));
		// The card's type-back field, registered the way the card will: the session wipes it at the commit.
		const field = { value: TYPED };
		session.registerInput(field);
		f.onClose = () => {
			seen.field = field.value;
			seen.words = session.words;
			seen.key = session.held('key');
			seen.sealed = seams.sealed[0]?.length ? seams.sealed[0].every((byte) => byte === 0) : null;
			const eaos = seams.snapEaos;
			seen.profile = eaos?.length ? eaos.every((byte) => byte === 0) : null;
		};

		await submit(flow);

		expect(seen).toEqual({ field: '', words: null, key: null, sealed: true, profile: true });
	});

	// The honest line when the browser cannot finish the file: nothing on the device, and the person told so.
	it('close() rejecting says the backup was not saved', async () => {
		const f = fakeFile();
		f.failClose = true;
		const { session, flow } = await rig(pickerOf(f.handle));

		expect(await submit(flow)).toEqual({ kind: 'failed', code: 'E_SAVE_FAILED' });

		expect(f.content).toBe('');
		expect((await readDeviceState(db)).mark).toBeNull();
		expect(session.phase).toBe('done');
		expect(session.committing).toBe(false);
		expect(session.busy).toBe(false);
	});

	// A hide while the bytes are going out stops the write and leaves the old file exactly as it was.
	it('an abort during write() calls writable.abort() and says nothing was saved', async () => {
		const f = fakeFile({ existing: '' });
		f.writeGate = deferred();
		const { session, flow, relock } = await rig(pickerOf(f.handle));

		const pending = submit(flow);
		await vi.waitFor(() => expect(f.writes).toBe(1));
		relock('hygiene');
		expect(f.aborts).toBe(1);
		f.writeGate.resolve();

		expect(await pending).toEqual({ kind: 'stopped' });
		expect(f.closes).toBe(0);
		expect(f.content).toBe('');
		expect(session.message).toBe('E_LEFT_APP');
		expect(session.phase).toBe('typed-back');
		expect(session.words).not.toBeNull();
		expect((await readDeviceState(db)).mark).toBeNull();
	});

	// A provider that never answers createWritable must not strand Cancel in "stopping"; a stream that arrives late is
	// still aborted, so no swap file is left behind.
	it('a Cancel while createWritable never settles ends with the cancelled line and aborts the late stream', async () => {
		const f = fakeFile();
		f.createGate = deferred();
		const { session, flow } = await rig(pickerOf(f.handle));

		const pending = submit(flow);
		await vi.waitFor(() => expect(f.created).toBe(1));
		expect(session.cancel()).toBe(true);

		expect(await within(pending)).toEqual({ kind: 'stopped' });
		expect(session.stopping).toBe(false);
		expect(session.message).toBe('E_EXPORT_CANCELLED');
		f.createGate.resolve();
		await vi.waitFor(() => expect(f.aborts).toBe(1));
		expect(f.writes).toBe(0);
	});

	// Cancel during the read: the decoded profile is wiped when the read finishes, and no file is touched.
	it('a Cancel during the snapshot wipes the decoded profile and writes nothing', async () => {
		const f = fakeFile();
		const reached = deferred<void>();
		const release = deferred<void>();
		seams.afterSnapshot = async () => {
			reached.resolve();
			await release.promise;
		};
		const { session, flow } = await rig(pickerOf(f.handle));

		const pending = submit(flow);
		await reached.promise;
		expect(session.cancel()).toBe(true);
		release.resolve();

		expect(await pending).toEqual({ kind: 'stopped' });
		expect(seams.snapEaos?.length).toBeGreaterThan(0);
		expect(seams.snapEaos?.every((byte) => byte === 0)).toBe(true);
		expect(f.created).toBe(0);
		expect(session.message).toBe('E_EXPORT_CANCELLED');
	});
});

describe('checking the file after it is saved', () => {
	// The page left right after the save: the file is there and the "Last backup" date is kept, but nobody read it back.
	// Navigating away leaves the profile unlocked, so the date is recorded; a page that is hidden for good is relocked by
	// the lifecycle first (hygiene, then the session's own pagehide), so the date keeps its older value.
	it.each([
		['the person navigates away', (s: BackupSession) => s.cardGone(), true],
		[
			'the page is hidden for good',
			(_s: BackupSession, relock: (reason: RelockReason) => void) => {
				relock('hygiene');
				window.dispatchEvent(new Event('pagehide'));
			},
			false
		]
	])(
		'an abort injected between close and getFile reports Saved, but not checked: %s',
		async (_name, leave, markWritten) => {
			const f = fakeFile();
			const { session, flow, relock } = await rig(pickerOf(f.handle));
			const backupAt = session.backupAt;
			f.onClose = () => leave(session, relock);

			expect(await submit(flow)).toEqual({ ...SAVED, readBack: 'not-checked' });

			expect(f.reads).toBe(1);
			expect((await readDeviceState(db)).mark?.at).toBe(markWritten ? backupAt : undefined);
		}
	);

	// A file that is not the one we wrote may not open: say so, and keep the date, because a file exists.
	it('a read-back mismatch is reported and the mark is still written', async () => {
		const f = fakeFile();
		f.mangle = true;
		const { flow } = await rig(pickerOf(f.handle));

		expect(await submit(flow)).toEqual({ ...SAVED, readBack: 'mismatch' });

		expect((await readDeviceState(db)).mark).not.toBeNull();
	});

	it.each(['reject', 'hang'] as const)(
		'a read-back that %ss says it was not checked',
		async (how) => {
			const f = fakeFile();
			f.readBack = how;
			const { session, flow } = await rig(pickerOf(f.handle), { readBackMs: 30 });

			expect(await submit(flow)).toEqual({ ...SAVED, readBack: 'not-checked' });

			expect(session.phase).toBe('done');
			expect((await readDeviceState(db)).mark).not.toBeNull();
		}
	);
});

describe('what stops a backup before anything is written', () => {
	// A seal that does not open again must never reach the file: the person would find out only at restore time.
	it.each([
		['a damaged seal', 'flip'],
		['a seal under another key', 'otherKey'],
		['a seal of bytes that are not the snapshot', 'otherBytes']
	] as const)('a seal that does not open is not written: %s', async (_name, how) => {
		seams.seal = how;
		const f = fakeFile();
		const { session, flow } = await rig(pickerOf(f.handle));

		expect(await submit(flow)).toEqual({ kind: 'failed', code: 'E_CRYPTO_FAILED' });

		expect(f.created).toBe(0);
		expect(f.content).toBe('');
		expect(session.phase).toBe('typed-back');
		expect(session.message).toBe('E_CRYPTO_FAILED');
		expect(session.words).not.toBeNull();
		expect((await readDeviceState(db)).mark).toBeNull();
	});

	it('a key step that fails keeps the words and writes nothing', async () => {
		kdf.reply = { type: 'error', code: 'E_NO_MEMORY' };
		const f = fakeFile();
		const { session, flow } = await rig(pickerOf(f.handle));

		expect(await submit(flow)).toEqual({ kind: 'failed', code: 'E_NO_MEMORY' });

		expect(session.message).toBe('E_NO_MEMORY');
		expect(session.phase).toBe('typed-back');
		expect(session.words).not.toBeNull();
		expect(f.created).toBe(0);
	});

	it('a device that cannot be read names the store and writes nothing', async () => {
		await withStores(db, 'profile-hwm', 'readwrite', (tx) => {
			tx.objectStore('profile-hwm').delete(0);
		});
		const f = fakeFile();
		const { session, flow } = await rig(pickerOf(f.handle));

		expect(await submit(flow)).toEqual({
			kind: 'failed',
			code: 'E_SNAPSHOT_FAILED',
			store: 'profile'
		});

		expect(session.message).toBe('E_SNAPSHOT_FAILED');
		expect(f.created).toBe(0);
	});

	// No message, result or log line may carry a word of the passphrase.
	it('no word of the passphrase reaches a result or a log line', async () => {
		seams.seal = 'flip';
		const { flow } = await rig(pickerOf(fakeFile().handle));
		const results = [
			await submit(flow, 'bamboo copper harvest lantern oxygen thimbl'),
			await submit(flow)
		];

		const seen = JSON.stringify([results, getDiagnosticsForTest()]);
		for (const word of WORDS) expect(seen).not.toContain(word);
	});
});
