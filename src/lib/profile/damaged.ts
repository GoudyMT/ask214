import { AesGcmAuthError } from '../crypto/aes-gcm';
import { SidecarTamperError } from './sidecars';
import { KeystoreHmacMismatchError } from './store.svelte';

/**
 * Whether a profile load failed because the data saved on this device fails the app's own checks. A reload reads the
 * same bytes and fails the same way, so this is the one start-up failure offered an erase. Anything else - an app older
 * than its database, a blocked open, a lock timeout, a storage error - can pass, so its data is never offered for
 * erase. One failure that does not pass is still not offered: a profile field of the wrong type fails its schema on
 * every reload and keeps the start-up banner, because only a fault in this app's own writer can make one. Bootstrap
 * writes the key record and the high-water mark in one transaction, so a mark missing beside a key record, or a body
 * missing once the mark says one was saved, is damage too. This holds only while every change to how saved data is
 * checked raises DB_VERSION (schema.ts): an older app must stop at the version, never here, where it would read a
 * newer release's data as damaged.
 */
export function isDamagedRecord(e: unknown): boolean {
	return (
		e instanceof KeystoreHmacMismatchError ||
		e instanceof SidecarTamperError ||
		e instanceof AesGcmAuthError ||
		(e instanceof Error &&
			(e.message === 'E_HWM_MISSING' || e.message === 'E_PROFILE_BODY_MISSING'))
	);
}

/**
 * Whether the data is still damaged, checked again just before an erase: another tab may have erased it and started
 * again since this one failed, and that tab's new data must never be wiped. A check that fails for any other reason
 * says nothing about the bytes, so it is not damage either - nothing is erased on a guess. `check` reads the saved data
 * the way start-up does and drops what it read.
 */
export async function stillDamaged(check: () => Promise<unknown>): Promise<boolean> {
	try {
		await check();
		return false;
	} catch (e) {
		return isDamagedRecord(e);
	}
}
