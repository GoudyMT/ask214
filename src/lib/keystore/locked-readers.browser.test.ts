import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createByokStore } from '../ask/byok/store';
import { KDF_V1 } from '../backup/kdf-params';
import { createCalendarSyncStore } from '../calendar/store.svelte';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { reqToPromise, STORES, withStores, type StoreName } from '../db/schema';
import { signSidecar } from '../profile/sidecars';
import { createProfileStore } from '../profile/store.svelte';
import { createFinderPackStore } from '../skillbridge-finder/state/pack-store.svelte';
import { createFinderStore } from '../skillbridge-finder/state/store.svelte';
import { createTimelineStateStore } from '../timeline/state.svelte';
import { bumpCounter, readCounter } from './app-lock-store';
import { bootstrapLocalKeystore } from './bootstrap';
import { signKeystore, type KeystoreRecordPin } from './record';
import { readKeystoreRow } from './read';
import {
	dropSession,
	getSession,
	KeystoreLockedError,
	openPinSession,
	setOnSessionMismatch,
	setSession,
	withOwnKeyChange
} from './session';

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
});

afterEach(async () => {
	dropSession();
	setOnSessionMismatch(null);
	await deleteTestDb(db);
});

/**
 * A PIN row from test-made keys: the MAC key and the wrapping key are non-extractable, as the PIN step makes them. The
 * data key and the HMAC key are made extractable ONLY here, to be wrapped into the bag.
 */
async function pinFixture() {
	const macKey = await crypto.subtle.generateKey(
		{ name: 'HMAC', hash: 'SHA-256', length: 256 },
		false,
		['sign', 'verify']
	);
	const kek = await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, [
		'wrapKey',
		'unwrapKey'
	]);
	const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
		'encrypt',
		'decrypt'
	]);
	const hmacKey = await crypto.subtle.generateKey(
		{ name: 'HMAC', hash: 'SHA-256', length: 256 },
		true,
		['sign', 'verify']
	);
	const bag = new Uint8Array(80);
	bag.set(new Uint8Array(await crypto.subtle.wrapKey('raw', dataKey, kek, 'AES-KW')), 0);
	bag.set(new Uint8Array(await crypto.subtle.wrapKey('raw', hmacKey, kek, 'AES-KW')), 40);
	const row: KeystoreRecordPin & { id: number } = {
		id: 0,
		v: 1,
		mode: 'pin',
		keystoreGeneration: 0,
		epoch: 0,
		ivCounter: 0,
		installUuid: crypto.getRandomValues(new Uint8Array(16)),
		kdf: { ...KDF_V1 },
		salt: crypto.getRandomValues(new Uint8Array(16)),
		bag
	};
	row.recordHmac = await signKeystore(row, { bootstrapMacKey: macKey });
	return { row, macKey, kek };
}

const putRaw = (store: StoreName, value: Record<string, unknown>) =>
	withStores(db, store, 'readwrite', (tx) => {
		tx.objectStore(store).put(value);
	});

const readRaw = (store: StoreName) =>
	withStores(db, store, 'readonly', (tx) =>
		reqToPromise<Record<string, unknown> | undefined>(tx.objectStore(store).get(0))
	);

/** Every row of every store, as plain data, for a before-and-after comparison. */
const snapshot = async () =>
	Object.fromEntries(
		await Promise.all(
			STORES.map(
				async (store) =>
					[
						store,
						await withStores(db, store, 'readonly', (tx) =>
							reqToPromise<unknown[]>(tx.objectStore(store).getAll())
						)
					] as const
			)
		)
	);

/** A device whose keystore is in PIN mode, in a tab with no session, holding rows the stores must not touch. */
async function lockedDevice() {
	await bootstrapLocalKeystore(db);
	const f = await pinFixture();
	await putRaw('keystore', f.row);
	const junk = () => ({ id: 0, rec: crypto.getRandomValues(new Uint8Array(64)) });
	for (const store of [
		'profile',
		'timeline-state',
		'calendar-sync',
		'byok',
		'skillbridge-finder'
	] as const) {
		await putRaw(store, junk());
	}
	await putRaw('skillbridge-finder-pack', {
		id: 'seen',
		rec: crypto.getRandomValues(new Uint8Array(64))
	});
	return f;
}

describe('with a PIN row and no session, no store reads or writes', () => {
	const KEY = 'sk-ant-test-key';
	const cases: [string, () => Promise<unknown>][] = [
		['profile load', () => createProfileStore(db).load()],
		['profile save', () => createProfileStore(db).save({ setupIntent: 'completed' })],
		['timeline load', () => createTimelineStateStore(db).load()],
		['timeline save', () => createTimelineStateStore(db).setStatus('dd214-review', 'done')],
		['calendar load', () => createCalendarSyncStore(db).load()],
		[
			'calendar save',
			() => createCalendarSyncStore(db).setExclusions({ taskIds: ['t1'], categories: [] })
		],
		['byok read', () => createByokStore(db).readApiKey()],
		['byok save', () => createByokStore(db).saveApiKey(KEY)],
		['finder load', () => createFinderStore(db).load()],
		['finder save', () => createFinderStore(db).setSetup({ radius: 50 })],
		['pack load', () => createFinderPackStore(db).load()]
	];

	it.each(cases)('%s: refused as locked, every stored row byte-equal', async (_name, run) => {
		await lockedDevice();
		const before = await snapshot();
		await expect(run()).rejects.toThrow(KeystoreLockedError);
		// Strict, because toEqual reads two ArrayBuffers of different bytes (recordHmac, a MAC) as equal.
		expect(await snapshot()).toStrictEqual(before);
	});
});

describe('a PIN session across a reload', () => {
	it('saves under the PIN MAC key, locks on reload, and reads the profile back after an unlock', async () => {
		const { row, macKey, kek } = await pinFixture();
		await putRaw('keystore', row);
		const counter = await readCounter(db);
		const session = await openPinSession(row, { macKey, kek }, counter);
		setSession(session);
		await putRaw('profile-hwm', {
			id: 0,
			...(await signSidecar(
				'profile-hwm',
				{ generation: 0, keystoreGeneration: 0, epoch: 0, ts: Date.now() },
				session.hmacKey
			))
		});

		await createProfileStore(db).save({
			eaos: new TextEncoder().encode('2027-04-15'),
			setupIntent: 'completed'
		});

		// A reload: the tab's memory is gone, the device's rows are not.
		dropSession();
		const reloaded = createProfileStore(db);
		await expect(reloaded.load()).rejects.toThrow(KeystoreLockedError);

		const stored = await readRaw('keystore');
		if (!stored) throw new Error('test setup: keystore missing');
		expect(stored.ivCounter).toBe(1);
		setSession(
			await openPinSession(stored as unknown as KeystoreRecordPin, { macKey, kek }, counter)
		);
		const loaded = await reloaded.load();
		expect(new TextDecoder().decode(loaded?.eaos ?? undefined)).toBe('2027-04-15');
		const checked = await readKeystoreRow(db);
		expect(checked.row.mode).toBe('pin');
	});

	it('leaves a stored PIN row with no key handle: only the salt, the KDF tuple and the bag', async () => {
		const { row, macKey, kek } = await pinFixture();
		await putRaw('keystore', row);
		const session = await openPinSession(row, { macKey, kek }, 0);
		setSession(session);
		await putRaw('profile-hwm', {
			id: 0,
			...(await signSidecar(
				'profile-hwm',
				{ generation: 0, keystoreGeneration: 0, epoch: 0, ts: Date.now() },
				session.hmacKey
			))
		});
		await createProfileStore(db).save({ setupIntent: 'completed' });

		const stored = await readRaw('keystore');
		expect(Object.keys(stored ?? {}).sort()).toEqual([
			'bag',
			'epoch',
			'id',
			'installUuid',
			'ivCounter',
			'kdf',
			'keystoreGeneration',
			'mode',
			'recordHmac',
			'salt',
			'v'
		]);
	});
});

describe('readKeystoreRow with a live session', () => {
	const open = async () => {
		const { row, macKey, kek } = await pinFixture();
		await putRaw('keystore', row);
		const counter = await readCounter(db);
		setSession(await openPinSession(row, { macKey, kek }, counter));
		const handler = vi.fn();
		setOnSessionMismatch(handler);
		return handler;
	};

	it('returns the row and the session keys while the lock counter is the one the session noted', async () => {
		await open();
		const { row, keys } = await readKeystoreRow(db);
		expect(row.mode).toBe('pin');
		expect(keys.dataKey).toBe(getSession()?.dataKey);
	});

	// A wipe writes old + 1 and a restore may write anything, so any change means the keys may no longer fit the rows.
	it('relocks the tab when the counter went up since the session noted it', async () => {
		const handler = await open();
		await bumpCounter(db);
		await expect(readKeystoreRow(db)).rejects.toThrow(KeystoreLockedError);
		expect(getSession()).toBeNull();
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('relocks the tab when the counter went down (a restore from an older copy)', async () => {
		await bumpCounter(db);
		await bumpCounter(db);
		const handler = await open();
		await withStores(db, 'app-lock', 'readwrite', (tx) => {
			tx.objectStore('app-lock').put({ id: 'counter', value: 1 });
		});
		await expect(readKeystoreRow(db)).rejects.toThrow(KeystoreLockedError);
		expect(getSession()).toBeNull();
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('inside its own key change a moved counter is refused without dropping the session', async () => {
		const handler = await open();
		await bumpCounter(db);
		await withOwnKeyChange(async () => {
			await expect(readKeystoreRow(db)).rejects.toThrow(KeystoreLockedError);
		});
		expect(getSession()).not.toBeNull();
		expect(handler).not.toHaveBeenCalled();
	});
});
