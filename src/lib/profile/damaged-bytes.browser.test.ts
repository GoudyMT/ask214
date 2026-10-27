import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { withStores, type StoreName } from '../db/schema';
import { bumpCounter } from '../keystore/app-lock-store';
import { KeystoreHmacMismatchError } from '../keystore/read';
import {
	checkStoredBytes,
	keystoreHasIdentity,
	readStoredBytes,
	sameStored
} from './damaged-bytes';

describe('sameStored', () => {
	const bytes = (...n: number[]) => new Uint8Array(n);

	it('reads equal values, byte arrays included, as equal', () => {
		const a = { id: 0, v: 1, bag: bytes(1, 2, 3), nest: { mac: bytes(9).buffer, list: [1, 'x'] } };
		const b = { id: 0, v: 1, bag: bytes(1, 2, 3), nest: { mac: bytes(9).buffer, list: [1, 'x'] } };
		expect(sameStored(a, b)).toBe(true);
	});

	// A record that differs by one stored byte is not the data that failed: it must never be erased on that failure.
	it.each([
		['one byte of a byte array changed', { bag: bytes(1, 2, 3) }, { bag: bytes(1, 2, 4) }],
		['a byte array of another length', { bag: bytes(1, 2, 3) }, { bag: bytes(1, 2) }],
		['one byte of a buffer changed', { mac: bytes(5).buffer }, { mac: bytes(6).buffer }],
		['a number changed', { n: 1 }, { n: 2 }],
		['a field missing', { a: 1, b: 2 }, { a: 1 }],
		['a record missing', { a: 1 }, undefined],
		['a record that appeared', undefined, { a: 1 }],
		['a list changed', { l: [1, 2] }, { l: [1, 3] }]
	])('reads %s as different', (_name, a, b) => {
		expect(sameStored(a, b)).toBe(false);
	});

	it('reads two absent records as the same', () => {
		expect(sameStored(undefined, undefined)).toBe(true);
	});
});

describe('keystoreHasIdentity', () => {
	const identity = {
		v: 1 as const,
		keystoreGeneration: 3,
		epoch: 2,
		installUuid: new Uint8Array(16).fill(7)
	};

	it('matches the row the identity came from, and only that one', () => {
		expect(keystoreHasIdentity({ ...identity }, identity)).toBe(true);
		expect(keystoreHasIdentity({ ...identity, epoch: 3 }, identity)).toBe(false);
		expect(
			keystoreHasIdentity({ ...identity, installUuid: new Uint8Array(16).fill(8) }, identity)
		).toBe(false);
		expect(keystoreHasIdentity(undefined, identity)).toBe(false);
		expect(keystoreHasIdentity('not a row', identity)).toBe(false);
	});
});

describe('the stored bytes of a store that failed its checks', () => {
	let db: IDBDatabase;
	beforeEach(async () => {
		db = await openTestDb();
	});
	afterEach(() => deleteTestDb(db));

	const put = (store: StoreName, value: Record<string, unknown>) =>
		withStores(db, store, 'readwrite', (tx) => {
			tx.objectStore(store).put(value);
		});
	const remove = (store: StoreName) =>
		withStores(db, store, 'readwrite', (tx) => {
			tx.objectStore(store).delete(0);
		});

	// A PIN row holds no key handle, so the same row reads back equal every time.
	const KEYSTORE = {
		id: 0,
		v: 1,
		mode: 'pin',
		keystoreGeneration: 0,
		epoch: 0,
		ivCounter: 4,
		installUuid: new Uint8Array(16).fill(1),
		salt: new Uint8Array(16).fill(2),
		bag: new Uint8Array(80).fill(3)
	};
	const HWM = { id: 0, v: 1, payload: { generation: 1 }, mac: new Uint8Array(32).fill(4) };
	const body = (last: number) => ({ id: 0, rec: new Uint8Array([1, 2, 3, last]) });

	async function damagedDevice() {
		await put('keystore', KEYSTORE);
		await put('profile-hwm', HWM);
		await put('profile', body(9));
		return readStoredBytes(db);
	}

	it('still reads as damaged when nothing was written since', async () => {
		const before = await damagedDevice();
		await expect(checkStoredBytes(db, before)).rejects.toThrow(KeystoreHmacMismatchError);
	});

	it('does not read as damaged once the profile row changed', async () => {
		const before = await damagedDevice();
		await put('profile', body(10));
		await expect(checkStoredBytes(db, before)).resolves.toBeUndefined();
	});

	it.each([
		['the keystore row', 'keystore'],
		['the mark', 'profile-hwm'],
		['the profile row', 'profile']
	] as const)('does not read as damaged once %s is gone', async (_name, store) => {
		const before = await damagedDevice();
		await remove(store);
		await expect(checkStoredBytes(db, before)).resolves.toBeUndefined();
	});

	it('does not read as damaged once the keystore row was rewritten', async () => {
		const before = await damagedDevice();
		await put('keystore', { ...KEYSTORE, ivCounter: 5 });
		await expect(checkStoredBytes(db, before)).resolves.toBeUndefined();
	});

	// The check holds no key and no counter, so a Lock between the failure and the erase changes nothing about it.
	it('does not depend on the lock counter', async () => {
		const before = await damagedDevice();
		await bumpCounter(db);
		await expect(checkStoredBytes(db, before)).rejects.toThrow(KeystoreHmacMismatchError);
		expect((await readStoredBytes(db)).counter).toBe(before.counter + 1);
	});
});
