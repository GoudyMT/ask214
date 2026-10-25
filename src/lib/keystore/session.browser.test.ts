import { afterEach, describe, expect, it, vi } from 'vitest';
import { KDF_V1 } from '../backup/kdf-params';
import { keyIdentity, signKeystore, type KeystoreRecordPin, type KeystoreRecordV1 } from './record';
import { keysForRow, type KeystoreRow } from './read';
import {
	assertSessionKeys,
	dropSession,
	getSession,
	KeystoreLockedError,
	openPinSession,
	setOnSessionMismatch,
	setSession,
	WrongPinError,
	withOwnKeyChange
} from './session';

const HMAC = { name: 'HMAC', hash: 'SHA-256', length: 256 } as const;

/**
 * A PIN row built from test-made keys: the MAC key and the wrapping key are non-extractable, as the PIN step makes
 * them. The data key and the HMAC key are made extractable ONLY here, to be wrapped into the bag.
 */
async function pinFixture(opts: { generation?: number } = {}) {
	const macKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
	const kek = await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, [
		'wrapKey',
		'unwrapKey'
	]);
	const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
		'encrypt',
		'decrypt'
	]);
	const hmacKey = await crypto.subtle.generateKey(HMAC, true, ['sign', 'verify']);
	const bag = new Uint8Array(80);
	bag.set(new Uint8Array(await crypto.subtle.wrapKey('raw', dataKey, kek, 'AES-KW')), 0);
	bag.set(new Uint8Array(await crypto.subtle.wrapKey('raw', hmacKey, kek, 'AES-KW')), 40);
	const row: KeystoreRecordPin & { id: number } = {
		id: 0,
		v: 1,
		mode: 'pin',
		keystoreGeneration: opts.generation ?? 0,
		epoch: 0,
		ivCounter: 0,
		installUuid: crypto.getRandomValues(new Uint8Array(16)),
		kdf: { ...KDF_V1 },
		salt: crypto.getRandomValues(new Uint8Array(16)),
		bag
	};
	row.recordHmac = await signKeystore(row, { bootstrapMacKey: macKey });
	return { row, macKey, kek, dataKey, hmacKey };
}

async function localRow(): Promise<KeystoreRecordV1 & { id: number }> {
	const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
		'encrypt',
		'decrypt'
	]);
	const hmacKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
	return {
		id: 0,
		v: 1,
		mode: 'local',
		keystoreGeneration: 0,
		epoch: 0,
		ivCounter: 0,
		installUuid: new Uint8Array(16).fill(9),
		dataKeyRef: dataKey,
		hmacKeyRef: hmacKey
	};
}

afterEach(() => {
	dropSession();
	setOnSessionMismatch(null);
});

describe('assertSessionKeys: every session key is non-extractable with its algorithm and usages', () => {
	const good = async () => {
		const { row, macKey, kek } = await pinFixture();
		return openPinSession(row, { macKey, kek }, 0);
	};

	it('passes the keys openPinSession unwrapped', async () => {
		const s = await good();
		expect(() => assertSessionKeys(s)).not.toThrow();
		for (const key of [s.dataKey, s.hmacKey, s.bootstrapMacKey])
			expect(key.extractable).toBe(false);
	});

	it.each([
		[
			'a data key made extractable',
			async () =>
				crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']),
			'dataKey'
		],
		[
			'a data key with only one usage',
			async () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']),
			'dataKey'
		],
		[
			'a 128-bit data key',
			async () =>
				crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']),
			'dataKey'
		],
		[
			'an HMAC key made extractable',
			async () => crypto.subtle.generateKey(HMAC, true, ['sign', 'verify']),
			'hmacKey'
		],
		[
			'an HMAC key that can only sign',
			async () => crypto.subtle.generateKey(HMAC, false, ['sign']),
			'hmacKey'
		],
		[
			'an AES-GCM key where the HMAC key belongs',
			async () =>
				crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
			'hmacKey'
		],
		[
			'an HMAC key over another hash',
			async () =>
				crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-512', length: 256 }, false, [
					'sign',
					'verify'
				]),
			'bootstrapMacKey'
		],
		[
			'a PIN MAC key made extractable',
			async () => crypto.subtle.generateKey(HMAC, true, ['sign', 'verify']),
			'bootstrapMacKey'
		]
	] as const)('refuses %s', async (_name, make, slot) => {
		const s = await good();
		const bad = { dataKey: s.dataKey, hmacKey: s.hmacKey, bootstrapMacKey: s.bootstrapMacKey };
		bad[slot] = await make();
		expect(() => assertSessionKeys(bad)).toThrow('E_KEY_SHAPE');
	});

	it('setSession runs the check, so a session with an extractable key is never held', async () => {
		const s = await good();
		const extractable = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
			'encrypt',
			'decrypt'
		]);
		expect(() => setSession({ ...s, dataKey: extractable })).toThrow('E_KEY_SHAPE');
		expect(getSession()).toBeNull();
	});
});

describe('openPinSession', () => {
	it('opens the bag into the keys it was wrapped from, and notes the row and the counter', async () => {
		const { row, macKey, kek, dataKey } = await pinFixture({ generation: 4 });
		const s = await openPinSession(row, { macKey, kek }, 12);
		expect(s.counter).toBe(12);
		expect(s.identity).toEqual(keyIdentity(row));
		expect(s.bootstrapMacKey).toBe(macKey);
		// The session's data key is the wrapped one: what it seals opens with the original, and the reverse.
		const iv = new Uint8Array(12);
		const sealed = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			s.dataKey,
			new Uint8Array(5)
		);
		expect(
			new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dataKey, sealed)).length
		).toBe(5);
		expect(getSession()).toBeNull();
	});

	it('is a wrong PIN when the record MAC does not verify under the PIN MAC key', async () => {
		const { row, kek } = await pinFixture();
		const other = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
			'sign',
			'verify'
		]);
		await expect(openPinSession(row, { macKey: other, kek }, 0)).rejects.toThrow(WrongPinError);
	});

	it('is a wrong PIN when the row carries no MAC', async () => {
		const { row, macKey, kek } = await pinFixture();
		const bare = { ...row };
		delete bare.recordHmac;
		await expect(openPinSession(bare, { macKey, kek }, 0)).rejects.toThrow(WrongPinError);
	});

	it('names its errors', () => {
		expect(new WrongPinError()).toMatchObject({ message: 'E_WRONG_PIN', name: 'WrongPinError' });
		expect(new KeystoreLockedError()).toMatchObject({
			message: 'E_KEYSTORE_LOCKED',
			name: 'KeystoreLockedError'
		});
	});
});

describe('a PIN row holds no key handle', () => {
	it('the type has neither handle to read', async () => {
		const { row } = await pinFixture();
		// @ts-expect-error a PIN row has no dataKeyRef
		const data: unknown = row.dataKeyRef;
		// @ts-expect-error a PIN row has no hmacKeyRef
		const hmac: unknown = row.hmacKeyRef;
		expect(data).toBeUndefined();
		expect(hmac).toBeUndefined();
	});
});

describe('keysForRow with a live session', () => {
	const open = async (generation = 0) => {
		const f = await pinFixture({ generation });
		const s = await openPinSession(f.row, { macKey: f.macKey, kek: f.kek }, 0);
		setSession(s);
		return { ...f, s };
	};
	const armed = () => {
		const handler = vi.fn();
		setOnSessionMismatch(handler);
		return handler;
	};

	it('gives a row that matches the session the session keys, not its own', async () => {
		const { row, s } = await open();
		const keys = keysForRow(row);
		expect(keys).toEqual({
			dataKey: s.dataKey,
			hmacKey: s.hmacKey,
			bootstrapMacKey: s.bootstrapMacKey
		});
	});

	it('relocks the tab when a local row appears under the session', async () => {
		await open();
		const handler = armed();
		const forged = await localRow();
		expect(() => keysForRow(forged)).toThrow(KeystoreLockedError);
		expect(getSession()).toBeNull();
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('relocks the tab when the PIN row is from another generation', async () => {
		const { row } = await open();
		const handler = armed();
		const changed: KeystoreRow = { ...row, keystoreGeneration: row.keystoreGeneration + 1 };
		expect(() => keysForRow(changed)).toThrow(KeystoreLockedError);
		expect(getSession()).toBeNull();
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('relocks the tab when the PIN row is from another install', async () => {
		const { row } = await open();
		const handler = armed();
		expect(() => keysForRow({ ...row, installUuid: new Uint8Array(16).fill(1) })).toThrow(
			KeystoreLockedError
		);
		expect(getSession()).toBeNull();
		expect(handler).toHaveBeenCalledTimes(1);
	});

	describe("inside this tab's own key change", () => {
		it('gives a local row its own handles and leaves the session alone', async () => {
			await open();
			const handler = armed();
			const local = await localRow();
			const keys = await withOwnKeyChange(async () => keysForRow(local));
			expect(keys.dataKey).toBe(local.dataKeyRef);
			expect(keys.bootstrapMacKey).toBe(local.hmacKeyRef);
			expect(getSession()).not.toBeNull();
			expect(handler).not.toHaveBeenCalled();
		});

		it('refuses a changed PIN row without dropping the session or telling the app', async () => {
			const { row } = await open();
			const handler = armed();
			const changed: KeystoreRow = { ...row, keystoreGeneration: row.keystoreGeneration + 1 };
			await withOwnKeyChange(async () => {
				expect(() => keysForRow(changed)).toThrow(KeystoreLockedError);
			});
			expect(getSession()).not.toBeNull();
			expect(handler).not.toHaveBeenCalled();
		});

		it('ends with the call, whether it returns or throws', async () => {
			const { row } = await open();
			const handler = armed();
			const changed: KeystoreRow = { ...row, keystoreGeneration: row.keystoreGeneration + 1 };
			await expect(
				withOwnKeyChange(() => Promise.reject(new Error('E_TEST_STOP')))
			).rejects.toThrow('E_TEST_STOP');
			expect(() => keysForRow(changed)).toThrow(KeystoreLockedError);
			expect(getSession()).toBeNull();
			expect(handler).toHaveBeenCalledTimes(1);
		});
	});
});

describe('keysForRow with no session', () => {
	it('refuses a PIN row and does not tell the app (there is nothing to relock)', async () => {
		const { row } = await pinFixture();
		const handler = vi.fn();
		setOnSessionMismatch(handler);
		expect(() => keysForRow(row)).toThrow(KeystoreLockedError);
		expect(handler).not.toHaveBeenCalled();
	});

	it('gives a local row its own handles, as before', async () => {
		const local = await localRow();
		expect(keysForRow(local)).toEqual({
			dataKey: local.dataKeyRef,
			hmacKey: local.hmacKeyRef,
			bootstrapMacKey: local.hmacKeyRef
		});
	});
});
