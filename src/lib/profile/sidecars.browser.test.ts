import { describe, it, expect, beforeAll } from 'vitest';
import {
	signSidecar,
	verifySidecar,
	type SignedSidecar,
	type ProfileHwmPayload,
	SidecarTamperError
} from './sidecars';
import { computeRecordHmac } from '../keystore/record';

let hmacKey: CryptoKey;

beforeAll(async () => {
	hmacKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
});

describe('signSidecar / verifySidecar', () => {
	const payload: ProfileHwmPayload = {
		generation: 3,
		keystoreGeneration: 0,
		epoch: 1,
		ts: 1716700000000
	};

	it('roundtrips a signed sidecar', async () => {
		const signed = await signSidecar('profile-hwm', payload, hmacKey);
		expect(signed.v).toBe(1);
		expect(signed.payload).toEqual(payload);
		expect(signed.mac.byteLength).toBe(32);

		const verified = await verifySidecar('profile-hwm', signed, hmacKey);
		expect(verified).toEqual(payload);
	});

	it('throws SidecarTamperError when payload is mutated', async () => {
		const signed = await signSidecar('profile-hwm', payload, hmacKey);
		const tampered: SignedSidecar<ProfileHwmPayload> = {
			...signed,
			payload: { ...signed.payload, generation: 99 }
		};
		await expect(verifySidecar('profile-hwm', tampered, hmacKey)).rejects.toThrow(
			SidecarTamperError
		);
	});

	it('throws SidecarTamperError when the MAC is mutated', async () => {
		const signed = await signSidecar('profile-hwm', payload, hmacKey);
		const tampered: SignedSidecar<ProfileHwmPayload> = {
			...signed,
			mac: new Uint8Array(32).fill(0xff).buffer
		};
		await expect(verifySidecar('profile-hwm', tampered, hmacKey)).rejects.toThrow(
			SidecarTamperError
		);
	});

	it('throws SidecarTamperError when the sidecar name is wrong', async () => {
		const signed = await signSidecar('profile-hwm', payload, hmacKey);
		await expect(verifySidecar('other-name', signed, hmacKey)).rejects.toThrow(SidecarTamperError);
	});

	it('cross-domain (T6-E): a sidecar MAC does not collide with a keystore-record HMAC for matching content', async () => {
		// Same key + overlapping fields; the mtc-v1|sidecar| vs mtc-v1|keystore-record|
		// domain prefixes (and distinct canonical formats) keep the two MAC domains
		// disjoint, so a stolen sidecar MAC can never authenticate a keystore record.
		const signed = await signSidecar('profile-hwm', payload, hmacKey);
		const recordHmac = await computeRecordHmac(
			{
				v: 1,
				mode: 'local',
				keystoreGeneration: 0,
				epoch: payload.epoch,
				ivCounter: 0,
				installUuid: new Uint8Array(16)
			},
			hmacKey
		);
		expect(Array.from(new Uint8Array(signed.mac))).not.toEqual(
			Array.from(new Uint8Array(recordHmac))
		);
	});
});
