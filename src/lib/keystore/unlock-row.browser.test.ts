import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { withStores } from '../db/schema';
import { bumpCounter } from './app-lock-store';
import { readPinRowAndCounter } from './unlock-row';

let db: IDBDatabase;
beforeEach(async () => {
	db = await openTestDb();
});
afterEach(() => deleteTestDb(db));

describe('readPinRowAndCounter', () => {
	it('gives the stored keystore row and the lock counter, read in one readonly transaction', async () => {
		const salt = crypto.getRandomValues(new Uint8Array(16));
		await withStores(db, 'keystore', 'readwrite', (tx) => {
			tx.objectStore('keystore').put({ id: 0, v: 1, mode: 'pin', salt });
		});
		await bumpCounter(db);
		await bumpCounter(db);

		const transaction = vi.spyOn(db, 'transaction');
		const { row, counter } = await readPinRowAndCounter(db);

		expect(transaction).toHaveBeenCalledTimes(1);
		expect(transaction).toHaveBeenCalledWith(['keystore', 'app-lock'], 'readonly');
		expect(counter).toBe(2);
		expect(row).toMatchObject({ id: 0, mode: 'pin' });
		expect(Array.from((row as unknown as { salt: Uint8Array }).salt)).toEqual(Array.from(salt));
	});

	// A lock removed or data erased elsewhere leaves no row; the unlock reloads on it rather than reading a missing key.
	it('gives no row, and the counter, when the keystore is empty', async () => {
		await bumpCounter(db);
		expect(await readPinRowAndCounter(db)).toEqual({ row: undefined, counter: 1 });
	});
});
