import { AesGcmAuthError } from '../crypto/aes-gcm';
import { SidecarTamperError } from './sidecars';
import { KeystoreHmacMismatchError } from './store.svelte';

/**
 * Whether a profile load failed because the data saved on this device fails the app's own checks. A reload reads the
 * same bytes and fails the same way, so this is the one start-up failure offered an erase. Anything else - an app older
 * than its database, a blocked open, a lock timeout, a storage error, any other throw - can pass, so its data is never
 * offered for erase. Bootstrap writes the key record and the high-water mark in one transaction, so a mark missing
 * beside a key record, or a body missing once the mark says one was saved, is damage too.
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
