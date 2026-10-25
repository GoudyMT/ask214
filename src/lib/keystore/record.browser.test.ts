import { describe, it, expect, beforeAll } from 'vitest';
import {
	canonicalizeKeystore,
	computeRecordHmac,
	keyIdentity,
	keyIdentityBytes,
	signKeystore,
	verifyKeystore,
	verifyRecordHmac,
	type KeystoreKeys,
	type KeystoreRecordV1
} from './record';

let hmacKey: CryptoKey;

beforeAll(async () => {
	hmacKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
});

// Canonical input excludes the CryptoKey refs + recordHmac (unserializable /
// self-referential); ivCounter remains in the type but is excluded from output.
const baseRecord: Omit<KeystoreRecordV1, 'dataKeyRef' | 'hmacKeyRef' | 'recordHmac'> = {
	v: 1,
	mode: 'local',
	keystoreGeneration: 0,
	epoch: 0,
	ivCounter: 0,
	installUuid: new Uint8Array(16).fill(1)
};

describe('canonicalizeKeystore', () => {
	it('emits a deterministic byte sequence for fixed inputs', () => {
		expect(Array.from(canonicalizeKeystore(baseRecord))).toEqual(
			Array.from(canonicalizeKeystore(baseRecord))
		);
	});

	it('changes when a config field changes (keystoreGeneration)', () => {
		const a = canonicalizeKeystore(baseRecord);
		const b = canonicalizeKeystore({ ...baseRecord, keystoreGeneration: 1 });
		expect(Array.from(a)).not.toEqual(Array.from(b));
	});

	it('changes when installUuid changes', () => {
		const a = canonicalizeKeystore(baseRecord);
		const b = canonicalizeKeystore({ ...baseRecord, installUuid: new Uint8Array(16).fill(2) });
		expect(Array.from(a)).not.toEqual(Array.from(b));
	});

	it('EXCLUDES ivCounter (operational, not security-relevant)', () => {
		const a = canonicalizeKeystore(baseRecord);
		const b = canonicalizeKeystore({ ...baseRecord, ivCounter: 999 });
		expect(Array.from(a)).toEqual(Array.from(b));
	});
});

describe('computeRecordHmac', () => {
	it('produces a stable HMAC for a stable record', async () => {
		const a = await computeRecordHmac(baseRecord, hmacKey);
		const b = await computeRecordHmac(baseRecord, hmacKey);
		expect(Array.from(new Uint8Array(a))).toEqual(Array.from(new Uint8Array(b)));
	});

	it('produces a different HMAC when a config field changes', async () => {
		const a = await computeRecordHmac(baseRecord, hmacKey);
		const b = await computeRecordHmac({ ...baseRecord, keystoreGeneration: 1 }, hmacKey);
		expect(Array.from(new Uint8Array(a))).not.toEqual(Array.from(new Uint8Array(b)));
	});

	it('is unaffected by ivCounter (excluded from the HMAC input)', async () => {
		const a = await computeRecordHmac(baseRecord, hmacKey);
		const b = await computeRecordHmac({ ...baseRecord, ivCounter: 999 }, hmacKey);
		expect(Array.from(new Uint8Array(a))).toEqual(Array.from(new Uint8Array(b)));
	});
});

describe('verifyRecordHmac', () => {
	it('accepts a MAC produced by computeRecordHmac for the same record', async () => {
		const mac = await computeRecordHmac(baseRecord, hmacKey);
		expect(await verifyRecordHmac(baseRecord, hmacKey, mac)).toBe(true);
	});

	it('rejects when a covered field is changed after signing', async () => {
		const mac = await computeRecordHmac(baseRecord, hmacKey);
		expect(await verifyRecordHmac({ ...baseRecord, keystoreGeneration: 1 }, hmacKey, mac)).toBe(
			false
		);
	});

	it('rejects a MAC computed over a different record', async () => {
		const foreign = await computeRecordHmac({ ...baseRecord, keystoreGeneration: 9 }, hmacKey);
		expect(await verifyRecordHmac(baseRecord, hmacKey, foreign)).toBe(false);
	});

	it('is unaffected by ivCounter (excluded from the HMAC input)', async () => {
		const mac = await computeRecordHmac(baseRecord, hmacKey);
		expect(await verifyRecordHmac({ ...baseRecord, ivCounter: 999 }, hmacKey, mac)).toBe(true);
	});
});

// Every encrypted record's AAD carries the SHA-256 of these bytes, so a changed byte here
// makes every stored record fail to open. The vector is the literal text, not the function.
describe('keyIdentityBytes', () => {
	const goldenRow = {
		...baseRecord,
		keystoreGeneration: 3,
		installUuid: Uint8Array.from({ length: 16 }, (_, i) => i)
	};

	it('is the exact canonical text and the same bytes canonicalizeKeystore gives', () => {
		const bytes = keyIdentityBytes(keyIdentity(goldenRow));
		expect(new TextDecoder().decode(bytes)).toBe(
			[
				'v=1',
				'mode=local',
				'keystoreGeneration=3',
				'epoch=0',
				'installUuid=000102030405060708090a0b0c0d0e0f'
			].join(String.fromCharCode(10))
		);
		expect(Array.from(bytes)).toEqual(Array.from(canonicalizeKeystore(goldenRow)));
	});
});

describe('signKeystore / verifyKeystore (local mode)', () => {
	const keys = (): KeystoreKeys => ({ dataKey: hmacKey, hmacKey, bootstrapMacKey: hmacKey });

	it('signs the same bytes computeRecordHmac gives, so a row stored by an older build still verifies', async () => {
		const mac = await signKeystore(baseRecord, keys());
		const old = await computeRecordHmac(baseRecord, hmacKey);
		expect(Array.from(new Uint8Array(mac))).toEqual(Array.from(new Uint8Array(old)));
		expect(await verifyKeystore({ ...baseRecord, recordHmac: old }, keys())).toBe(true);
	});

	// The MAC input is the literal domain prefix followed by the identity text; a stored row only verifies if these exact bytes are signed.
	it('signs the literal prefixed identity text', async () => {
		const text = [
			'mtc-v1|keystore-record|v=1',
			'mode=local',
			'keystoreGeneration=0',
			'epoch=0',
			`installUuid=${'01'.repeat(16)}`
		].join(String.fromCharCode(10));
		const expected = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(text));
		const mac = await signKeystore(baseRecord, keys());
		expect(Array.from(new Uint8Array(mac))).toEqual(Array.from(new Uint8Array(expected)));
	});

	it('rejects a row whose covered field changed after signing', async () => {
		const mac = await signKeystore(baseRecord, keys());
		expect(
			await verifyKeystore({ ...baseRecord, keystoreGeneration: 1, recordHmac: mac }, keys())
		).toBe(false);
	});

	it('rejects a row with no recordHmac', async () => {
		expect(await verifyKeystore(baseRecord, keys())).toBe(false);
	});
});
