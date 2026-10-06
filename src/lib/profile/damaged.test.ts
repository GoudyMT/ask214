import { describe, expect, it } from 'vitest';
import { isDamagedRecord } from './damaged';
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
