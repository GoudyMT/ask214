import { describe, it, expect, beforeAll } from 'vitest';
import {
	canonicalizeKeystore,
	computeRecordHmac,
	keyIdentity,
	keyIdentityBytes,
	recordCanonical,
	signKeystore,
	verifyKeystore,
	verifyRecordHmac,
	type KeystoreKeys,
	type KeystoreRecordPin,
	type KeystoreRecordV1
} from './record';
import { KDF_V1 } from '../backup/kdf-params';

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

	it('is the exact canonical text', () => {
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

// A PIN row has no key handle, so its MAC covers the salt and the wrapped bag as well: the bytes below are what every
// PIN row ever stored was signed over. The vector is written out, not built by the code under test.
describe('recordCanonical and the PIN record MAC', () => {
	const NL = String.fromCharCode(10);
	const bytesFrom = (start: number, count: number) =>
		Uint8Array.from({ length: count }, (_, i) => start + i);
	const pinRow = (): KeystoreRecordPin => ({
		v: 1,
		mode: 'pin',
		keystoreGeneration: 3,
		epoch: 1,
		ivCounter: 7,
		installUuid: bytesFrom(0, 16),
		kdf: { ...KDF_V1 },
		salt: bytesFrom(0x10, 16),
		bag: bytesFrom(0x20, 80)
	});
	const TEXT = [
		'v=1',
		'mode=local',
		'keystoreGeneration=3',
		'epoch=1',
		'installUuid=000102030405060708090a0b0c0d0e0f',
		'lock=pin',
		'kdf=argon2id-v19-m131072-t4-p2-len32',
		'salt=101112131415161718191a1b1c1d1e1f',
		[
			'bag=',
			'202122232425262728292a2b2c2d2e2f',
			'303132333435363738393a3b3c3d3e3f',
			'404142434445464748494a4b4c4d4e4f',
			'505152535455565758595a5b5c5d5e5f',
			'606162636465666768696a6b6c6d6e6f'
		].join('')
	].join(NL);
	const rawKey = (fill: number) =>
		crypto.subtle.importKey(
			'raw',
			new Uint8Array(32).fill(fill),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign', 'verify']
		);
	const hmacOver = async (key: CryptoKey, text: string) =>
		new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));

	it('is the exact text: the identity lines, then lock, kdf, salt and bag', () => {
		expect(new TextDecoder().decode(recordCanonical(pinRow()))).toBe(TEXT);
	});

	it('signs the pin prefix and that text under the PIN MAC key', async () => {
		const key = await rawKey(0xa5);
		const mac = await signKeystore(pinRow(), { bootstrapMacKey: key });
		const expected = await hmacOver(key, 'mtc-v1|keystore-record-pin|' + TEXT);
		expect(Array.from(new Uint8Array(mac))).toEqual(Array.from(expected));
		expect(await verifyKeystore({ ...pinRow(), recordHmac: mac }, { bootstrapMacKey: key })).toBe(
			true
		);
	});

	it('fails verify under another PIN MAC key (a wrong PIN)', async () => {
		const mac = await signKeystore(pinRow(), { bootstrapMacKey: await rawKey(0xa5) });
		expect(
			await verifyKeystore(
				{ ...pinRow(), recordHmac: mac },
				{ bootstrapMacKey: await rawKey(0x5a) }
			)
		).toBe(false);
	});

	// The local prefix over the same text must not pass as a PIN row's MAC, or a row could be passed off as the other mode.
	it('does not verify a MAC made with the local prefix (domain separation)', async () => {
		const key = await rawKey(0xa5);
		const wrongDomain = await hmacOver(key, 'mtc-v1|keystore-record|' + TEXT);
		expect(
			await verifyKeystore(
				{ ...pinRow(), recordHmac: wrongDomain.buffer },
				{ bootstrapMacKey: key }
			)
		).toBe(false);
	});

	it.each([
		['a salt of 15 bytes', { salt: new Uint8Array(15) }],
		['a bag of 79 bytes', { bag: new Uint8Array(79) }],
		['a salt that is not bytes', { salt: 'abcdefghijklmnop' as unknown as Uint8Array }]
	])('refuses odd bytes: %s is no row to sign or to trust', async (_name, odd) => {
		const row = { ...pinRow(), ...odd };
		expect(() => recordCanonical(row)).toThrow('E_KEYSTORE_SHAPE');
		const key = await rawKey(0xa5);
		await expect(signKeystore(row, { bootstrapMacKey: key })).rejects.toThrow('E_KEYSTORE_SHAPE');
		const mac = await signKeystore(pinRow(), { bootstrapMacKey: key });
		expect(await verifyKeystore({ ...row, recordHmac: mac }, { bootstrapMacKey: key })).toBe(false);
	});
});
