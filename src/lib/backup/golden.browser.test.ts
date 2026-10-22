import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCalendarSyncStore } from '../calendar/store.svelte';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { reqToPromise, STORES, withStores, type StoreName } from '../db/schema';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { encodeEaos, parseEaosAtRead } from '../profile/eaos';
import { createProfileStore, type ProfileStore } from '../profile/store.svelte';
import type { ProfileV1 } from '../profile/types';
import { cleanListing } from '../skillbridge-finder/fixtures/clean';
import { createFinderStore } from '../skillbridge-finder/state/store.svelte';
import { createTimelineStateStore } from '../timeline/state.svelte';
import { decryptEnvelope, readBackupFile, sealEnvelope } from './envelope';
import { BACKUP_MANIFEST } from './manifest';
import goldenText from './golden/v1-1.ask214backup?raw';
import { GOLDEN_EXPECTED, GOLDEN_PASSWORD, GOLDEN_SALT, GOLDEN_SHA256 } from './golden/golden';
import { RestoreFlow } from './restore-flow';
import { BackupSession, type WorkerLike } from './session.svelte';
import { createHandler } from './worker/handler';
import type { FromWorker, WorkerRequest } from './worker/protocol';
import { WORDS_V1 } from './words-v1';

// The slow key step is the only thing replaced: Argon2id answers with the pinned output when it is asked for exactly
// the pinned password, salt and settings (written out here, not read from the app), and fails for anything else. The
// real worker handler runs around it, so its HKDF step and its word check run for real.
vi.mock('@noble/hashes/argon2.js', async () => {
	const golden = await import('./golden/golden');
	const same = (a: Uint8Array, b: Uint8Array) =>
		a.length === b.length && a.every((x, i) => x === b[i]);
	return {
		argon2id: (pass: Uint8Array, salt: Uint8Array, opts: Record<string, unknown>) => {
			const asked =
				same(pass, new TextEncoder().encode(golden.GOLDEN_PASSWORD)) &&
				same(salt, golden.GOLDEN_SALT) &&
				opts.t === 4 &&
				opts.m === 131072 &&
				opts.p === 2 &&
				opts.version === 0x13 &&
				opts.dkLen === 32;
			if (!asked) throw new Error('E_TEST_ARGON_INPUT');
			return Uint8Array.from({ length: 32 }, (_, i) =>
				parseInt(golden.GOLDEN_ARGON2_HEX.slice(2 * i, 2 * i + 2), 16)
			);
		}
	};
});

type Row = Record<string, unknown>;

// The fields the device sets itself, so they are left out of the content compare: its own generation and clock mark,
// and the backup mark (lastBackupAt is stamped from the file's date but never later than the clock, so it depends on
// when the test runs).
const DEVICE_FIELDS = new Set([
	'generation',
	'lastSeenAt',
	'lastBackupAt',
	'backupGenProfile',
	'backupGenTimeline',
	'backupGenCalendar',
	'backupGenFinder'
]);

let db: IDBDatabase;
let profile: ProfileStore | undefined;
const START_URL = location.href;
const START_STATE: unknown = history.state;

beforeEach(async () => {
	db = await openTestDb();
});

afterEach(async () => {
	// The store holds the profile's date bytes; a screen that is done with them wipes them the same way.
	profile?.relockSync('hygiene');
	profile = undefined;
	await deleteTestDb(db);
	// A finished restore leaves the restored note in the history entry and the address on the Timeline.
	history.replaceState(START_STATE, '', START_URL);
});

/** The AES key the worker answers with for the golden's password and salt. */
async function workerKey(purpose: 'export' | 'restore'): Promise<CryptoKey> {
	const pass = new TextEncoder().encode(GOLDEN_PASSWORD).buffer;
	let answer: FromWorker | undefined;
	const { handle } = createHandler(WORDS_V1, (message) => {
		if (message.type !== 'progress') answer = message;
	});
	await handle({ op: 'derive', purpose, pass, salt: Uint8Array.from(GOLDEN_SALT) });
	if (answer?.type !== 'key') throw new Error('E_TEST_NO_KEY');
	return answer.key;
}

/** A device whose setup is finished and that already holds some content of its own for a restore to replace. */
async function finishedDevice() {
	await bootstrapLocalKeystore(db);
	const store = createProfileStore(db);
	profile = store;
	const eaos = encodeEaos(parseEaosAtRead('2027-01-01'));
	try {
		await store.save({ setupIntent: 'completed', eaos });
	} finally {
		eaos.fill(0);
	}
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	await timeline.setStatus('sha-complete', 'done');
	const calendar = createCalendarSyncStore(db);
	await calendar.load();
	await calendar.setExclusions({ taskIds: ['sha-schedule'], categories: [] });
	const finder = createFinderStore(db);
	await finder.load();
	await finder.setSetup({ radius: 25 });
	await finder.save(cleanListing(), '2026-10-21');
}

/** The key worker with the real handler behind it, answering later and with the passphrase buffer detached. */
class HandlerWorker implements WorkerLike {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onmessageerror: ((event: unknown) => void) | null = null;
	#dead = false;

	postMessage(message: WorkerRequest, transfer: Transferable[] = []): void {
		const arrived = structuredClone(message, { transfer }) as WorkerRequest;
		const { handle } = createHandler(WORDS_V1, (data) => {
			setTimeout(() => {
				if (!this.#dead) this.onmessage?.({ data });
			}, 0);
		});
		void handle(arrived);
	}

	terminate(): void {
		this.#dead = true;
	}
}

/**
 * The steps a person's restore takes, through the flow the card drives: choose the file, type the words, and press
 * Replace. The restore is written only if the file was read, opened and checked first.
 */
async function restoreFile(text: string): Promise<{ ok: true } | { ok: false; code: string }> {
	const win = new EventTarget();
	const session = new BackupSession({
		isVisible: () => true,
		hasFocus: () => true,
		setTimer: () => 0,
		clearTimer: () => {},
		getWindow: () => win,
		createWorker: () => new HandlerWorker(),
		getOpenPicker: () => async () => [
			{ getFile: async () => new File([text], 'backup.ask214backup') }
		]
	});
	const flow = new RestoreFlow({
		session,
		app: {
			status: 'ready',
			joinRelock: () => () => {},
			publish: () => {},
			store: null,
			reloadOnUnlock: false
		},
		db,
		waitForControl: () => Promise.resolve(true),
		reload: () => {}
	});
	try {
		await flow.open('restore');
		await flow.chooseFile();
		await flow.submit(GOLDEN_PASSWORD);
		await flow.replace();
		if (session.phase === 'committed') return { ok: true };
		return { ok: false, code: session.message ?? flow.confirm?.notice ?? 'E_NO_LINE' };
	} finally {
		session.end();
	}
}

/** The content of a loaded profile as the golden pins it: dates as ISO text, the device's own fields left out. */
function profileContent(loaded: ProfileV1): Record<string, unknown> {
	const content: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(loaded)) {
		if (DEVICE_FIELDS.has(key) || value === undefined) continue;
		content[key] = value instanceof Uint8Array ? new TextDecoder().decode(value) : value;
	}
	return content;
}

const toHex = (bytes: Uint8Array): string =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A row as plain text, bytes included, so two reads can be compared. A stored key cannot be read, so it is a label. */
function plain(value: unknown): unknown {
	if (value instanceof Uint8Array) return `u8:${toHex(value)}`;
	if (value instanceof ArrayBuffer) return `ab:${toHex(new Uint8Array(value))}`;
	if (value instanceof CryptoKey) return 'CryptoKey';
	if (Array.isArray(value)) return value.map(plain);
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([key, inner]) => [key, plain(inner)])
		);
	}
	return value;
}

// The stores a restore replaces or clears: every one the manifest does not mark 'never' (the API key and the finder's
// cached listings).
const RESTORE_TOUCHES: StoreName[] = STORES.filter((store) => BACKUP_MANIFEST[store] !== 'never');

/** The stores a restore replaces or clears, as the device holds them right now. */
async function restoredRows(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const store of RESTORE_TOUCHES) {
		out[store] = plain(
			await withStores(db, store, 'readonly', (tx) =>
				reqToPromise<Row | undefined>(tx.objectStore(store).get(0))
			)
		);
	}
	return out;
}

describe('the golden v1 / 1 backup', () => {
	it('the golden restores into a fresh device and loads deep-equal', async () => {
		await finishedDevice();

		expect(await restoreFile(goldenText)).toStrictEqual({ ok: true });

		// A reload: new stores over the same database.
		const reloaded = createProfileStore(db);
		profile = reloaded;
		const loaded = await reloaded.load();
		expect(loaded).not.toBeNull();
		if (!loaded) return;
		expect(profileContent(loaded)).toStrictEqual(GOLDEN_EXPECTED.profile);
		const timeline = createTimelineStateStore(db);
		await timeline.load();
		expect(JSON.parse(JSON.stringify(timeline.state))).toStrictEqual(GOLDEN_EXPECTED.timeline);
		const calendar = createCalendarSyncStore(db);
		await calendar.load();
		expect(
			JSON.parse(JSON.stringify({ exclusions: calendar.exclusions, card: calendar.card }))
		).toStrictEqual(GOLDEN_EXPECTED.calendar);
	}, 30_000);

	// The golden was made before the finder existed: it must still restore, and it leaves the finder empty, not holding
	// what this device saved since.
	it('the golden has no finder record and restoring it clears the finder and its marker', async () => {
		await finishedDevice();
		const before = await restoredRows();
		expect(before['skillbridge-finder']).toBeDefined();
		expect(before['skillbridge-finder-hwm']).toBeDefined();

		expect(await restoreFile(goldenText)).toStrictEqual({ ok: true });

		const after = await restoredRows();
		expect(after['skillbridge-finder']).toBeUndefined();
		expect(after['skillbridge-finder-hwm']).toBeUndefined();
		const finder = createFinderStore(db);
		await finder.load();
		expect(finder.ready).toBe(true);
		expect(finder.saved).toEqual([]);
		expect(finder.setup).toEqual({});
	}, 30_000);

	it("the golden's sha256 is pinned", async () => {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(goldenText));
		expect(toHex(new Uint8Array(digest))).toBe(GOLDEN_SHA256);
	});

	it('a backupSchema 2 inner is NEWER_VERSION and nothing is written', async () => {
		// The golden's own inner, opened with the pinned key, then marked as a later format and sealed the same way.
		const read = await readBackupFile(new File([goldenText], 'golden.ask214backup'));
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		const opened = await decryptEnvelope(read.envelope, await workerKey('restore'));
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const newer = new TextEncoder().encode(
			JSON.stringify({ ...(opened.inner as Row), backupSchema: 2 })
		);
		const sealed = await sealEnvelope(await workerKey('export'), newer, GOLDEN_SALT);

		await finishedDevice();
		const before = await restoredRows();

		expect(await restoreFile(sealed)).toStrictEqual({ ok: false, code: 'E_NEWER_VERSION' });
		expect(await restoredRows()).toStrictEqual(before);
	}, 30_000);
});
