import { describe, expect, it } from 'vitest';
import { isDamagedRecord, stillDamaged } from './damaged';
import { LockAcquisitionTimeout } from '../db/locks';
import { AesGcmAuthError } from '../crypto/aes-gcm';
import { SidecarTamperError } from './sidecars';
import {
	KeystoreHmacMismatchError,
	KeystoreNotInitializedError,
	OccConflictError
} from './store.svelte';

describe('isDamagedRecord', () => {
	// The saved data failing the app's own checks: a reload reads the same bytes and fails the same way, so erase is the
	// only way back.
	it.each([
		['the key record fails its check', new KeystoreHmacMismatchError()],
		['the high-water mark fails its check', new SidecarTamperError()],
		['the profile fails decryption', new AesGcmAuthError()],
		['the high-water mark is missing beside its key record', new Error('E_HWM_MISSING')],
		['the profile body is missing past its first save', new Error('E_PROFILE_BODY_MISSING')]
	])('is damage when %s', (_, e) => {
		expect(isDamagedRecord(e)).toBe(true);
	});

	// Failures that can pass, or that say nothing about the bytes: never offered an erase, so good data survives them.
	it.each([
		['an app older than its database', new DOMException('version', 'VersionError')],
		['a closed connection', new DOMException('closed', 'InvalidStateError')],
		['a lock timeout', new Error('E_TIMEOUT')],
		['a write race', new OccConflictError()],
		['a missing key record', new KeystoreNotInitializedError()],
		['a type error', new TypeError('x')],
		['a thrown string', 'E_HWM_MISSING'],
		['nothing', undefined]
	])('is not damage for %s', (_, e) => {
		expect(isDamagedRecord(e)).toBe(false);
	});
});

// Checked again just before an erase: another tab may have erased and set up new data since this one failed.
describe('stillDamaged', () => {
	it('is damage when the check fails the same way', async () => {
		expect(
			await stillDamaged(async () => {
				throw new KeystoreHmacMismatchError();
			})
		).toBe(true);
	});

	it('is not damage when the data now reads', async () => {
		expect(await stillDamaged(async () => {})).toBe(false);
	});

	// Nothing is erased on a guess: a check that cannot run says nothing about the bytes.
	it('is not damage when the check fails for another reason', async () => {
		expect(
			await stillDamaged(async () => {
				throw new LockAcquisitionTimeout();
			})
		).toBe(false);
	});
});
