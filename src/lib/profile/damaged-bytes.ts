import { readCounterIn } from '../keystore/app-lock-store';
import { keyIdentity, keyIdentityBytes, type KeyIdentity } from '../keystore/record';
import { KeystoreHmacMismatchError } from '../keystore/read';
import { reqToPromise, withStores } from '../db/schema';

/**
 * Checks a store that failed its own checks by the bytes that failed, not by reading it again under keys. After a
 * failed PIN unlock the keys are gone (a failure drops them), and a Lock or an idle lock on the damaged screen must not
 * take the person's way out away; the erase still has to know the data is the same data that failed and not something
 * another tab wrote since. Plain stored values hold no key and no plaintext: a PIN row has only a salt, a wrapped bag
 * and the settings that made them, and the profile row is ciphertext.
 */
export type StoredBytes = Readonly<{
	keystore: unknown;
	hwm: unknown;
	profile: unknown;
	/** For the guard at the moment of failure only; the later check never reads it. */
	counter: number;
}>;

/** The keystore row, the profile mark and the profile body as they are stored, and the lock counter, in one transaction. */
export function readStoredBytes(db: IDBDatabase): Promise<StoredBytes> {
	return withStores(
		db,
		['keystore', 'profile-hwm', 'profile', 'app-lock'],
		'readonly',
		async (tx) => {
			const [keystore, hwm, profile, counter] = await Promise.all([
				reqToPromise<unknown>(tx.objectStore('keystore').get(0)),
				reqToPromise<unknown>(tx.objectStore('profile-hwm').get(0)),
				reqToPromise<unknown>(tx.objectStore('profile').get(0)),
				readCounterIn(tx)
			]);
			return { keystore, hwm, profile, counter };
		}
	);
}

const bytesOf = (v: unknown): Uint8Array | null =>
	v instanceof ArrayBuffer
		? new Uint8Array(v)
		: ArrayBuffer.isView(v)
			? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
			: null;

const isPlain = (v: unknown): v is Record<string, unknown> => {
	if (typeof v !== 'object' || v === null) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
};

/**
 * Whether two stored values are the same by content, byte arrays and buffers compared byte by byte. Anything that is not
 * plain data (a key handle) is the same only as itself, which errs toward "different": a record that cannot be shown to
 * be unchanged is never treated as the damage that was seen.
 */
export function sameStored(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	const x = bytesOf(a);
	const y = bytesOf(b);
	if (x || y) return !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]);
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameStored(v, b[i]));
	}
	if (isPlain(a) && isPlain(b)) {
		const keys = Object.keys(a);
		return (
			keys.length === Object.keys(b).length && keys.every((k) => k in b && sameStored(a[k], b[k]))
		);
	}
	return false;
}

/** Whether a stored keystore row is the one of `identity`: the same install, generation and epoch. */
export function keystoreHasIdentity(row: unknown, identity: KeyIdentity): boolean {
	if (!isPlain(row)) return false;
	try {
		const mine = keyIdentityBytes(identity);
		const theirs = keyIdentityBytes(keyIdentity(row as Parameters<typeof keyIdentity>[0]));
		return mine.length === theirs.length && mine.every((v, i) => v === theirs[i]);
	} catch {
		return false;
	}
}

/** Whether the three records (not the counter) are the same in both reads. */
export function sameRecords(a: StoredBytes, b: StoredBytes): boolean {
	return (
		sameStored(a.keystore, b.keystore) &&
		sameStored(a.hwm, b.hwm) &&
		sameStored(a.profile, b.profile)
	);
}

/**
 * Reads the same three records again and compares them with `before`. Unchanged: the same bytes that failed under the
 * right keys, so still damaged, and it throws what a failed check throws. Changed or gone: another tab has written
 * since, so it resolves, and the caller reloads onto what is there and erases nothing.
 */
export async function checkStoredBytes(db: IDBDatabase, before: StoredBytes): Promise<void> {
	if (sameRecords(await readStoredBytes(db), before)) throw new KeystoreHmacMismatchError();
}
