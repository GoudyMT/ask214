import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { encryptFinderRecord, decryptFinderRecord } from './crypto-boundary';
import { FinderSchemaError } from './codec';
import { createFinderStore } from './store.svelte';
import { encryptRecord, decryptRecord } from '../../crypto/record-crypto';
import { AesGcmAuthError } from '../../crypto/aes-gcm';
import { bootstrapLocalKeystore } from '../../keystore/bootstrap';
import { openTestDb, deleteTestDb } from '../../db/_test-helpers';
import type { FinderRecord } from './types';
import type { KeystoreRecordV1 } from '../../keystore/record';

// Passthrough seams that record the byte buffers the boundary hands to its collaborators, so a test can look at them
// after the call: what the encoder returned, the copy given to the cipher, and what the decoder was given. Each also
// notes whether the buffer still held data when it was handed over (and, for the cipher, when encryption settled), which
// keeps "all zero afterwards" from passing on an empty buffer. The boundary seam records the calls the store makes to it.
const seen = vi.hoisted(() => ({
	encoded: [] as Uint8Array[],
	encodedFull: [] as boolean[],
	cipherInput: [] as Uint8Array[],
	cipherInputFullAtCall: [] as boolean[],
	cipherInputFullAtSettle: [] as boolean[],
	decoderInput: [] as Uint8Array[],
	decoderInputFull: [] as boolean[],
	encryptGenerations: [] as number[],
	decryptGenerations: [] as number[]
}));
const hasData = (b: Uint8Array): boolean => b.some((x) => x !== 0);

// `$lib` aliases on purpose: a relative path here never applied to the module under test in this runner.
vi.mock('$lib/skillbridge-finder/state/codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('./codec')>();
	return {
		...real,
		encodeFinderRecord: (r: FinderRecord) => {
			const out = real.encodeFinderRecord(r);
			seen.encoded.push(out);
			seen.encodedFull.push(hasData(out));
			return out;
		},
		decodeFinderRecord: (b: Uint8Array) => {
			seen.decoderInput.push(b);
			seen.decoderInputFull.push(hasData(b));
			return real.decodeFinderRecord(b);
		}
	};
});

vi.mock('$lib/crypto/record-crypto', async (importOriginal) => {
	const real = await importOriginal<typeof import('../../crypto/record-crypto')>();
	return {
		...real,
		encryptRecord: async (...args: Parameters<typeof real.encryptRecord>) => {
			const plaintext = args[1];
			seen.cipherInput.push(plaintext);
			seen.cipherInputFullAtCall.push(hasData(plaintext));
			const out = await real.encryptRecord(...args);
			seen.cipherInputFullAtSettle.push(hasData(plaintext));
			return out;
		}
	};
});

vi.mock('$lib/skillbridge-finder/state/crypto-boundary', async (importOriginal) => {
	const real = await importOriginal<typeof import('./crypto-boundary')>();
	return {
		...real,
		encryptFinderRecord: (...args: Parameters<typeof real.encryptFinderRecord>) => {
			seen.encryptGenerations.push(args[2]);
			return real.encryptFinderRecord(...args);
		},
		decryptFinderRecord: (...args: Parameters<typeof real.decryptFinderRecord>) => {
			seen.decryptGenerations.push(args[2]);
			return real.decryptFinderRecord(...args);
		}
	};
});

let dataKey: CryptoKey;
let hmacKey: CryptoKey;

beforeEach(() => {
	for (const list of Object.values(seen)) list.length = 0;
});

beforeAll(async () => {
	dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
		'encrypt',
		'decrypt'
	]);
	hmacKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify'
	]);
});

const baseKeystore = (): KeystoreRecordV1 => ({
	v: 1,
	mode: 'local',
	keystoreGeneration: 0,
	epoch: 0,
	ivCounter: 0,
	installUuid: new Uint8Array(16).fill(1),
	dataKeyRef: dataKey,
	hmacKeyRef: hmacKey
});

const baseRecord: FinderRecord = {
	schemaVersion: 1,
	finderSetup: { place: { kind: 'state', state: 'VA' }, radius: 'any' },
	finderFilters: { branches: ['Navy'] },
	finderSaved: [],
	finderCompare: [386]
};

describe('the finder store encrypts through its boundary', () => {
	it('saves and loads through the boundary pair, each once, at the record generation', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createFinderStore(db);
		await a.load();
		await a.setSetup({ radius: 50 });

		expect(seen.encryptGenerations).toEqual([1]);
		// No record existed at the first load, so nothing was decrypted yet.
		expect(seen.decryptGenerations).toEqual([]);

		const b = createFinderStore(db);
		await b.load();

		expect(seen.encryptGenerations).toEqual([1]);
		expect(seen.decryptGenerations).toEqual([1]);
		expect(b.setup).toEqual({ radius: 50 });
		await deleteTestDb(db);
	});
});

describe('encryptFinderRecord / decryptFinderRecord', () => {
	it('roundtrips a record through encrypt + decrypt', async () => {
		const ks = baseKeystore();
		const blob = await encryptFinderRecord(baseRecord, ks, 3);
		expect(await decryptFinderRecord(blob, ks, 3)).toEqual(baseRecord);
	});

	// The bytes on disk are bound to this store name and record id by their AAD, so a later writer of this record must
	// produce what the store reads: pin the literal context, not just a self-consistent pair.
	it('writes a record bound to the skillbridge-finder store context', async () => {
		const ks = baseKeystore();
		const blob = await encryptFinderRecord(baseRecord, ks, 3);
		const opened = decryptRecord(
			{ storeName: 'skillbridge-finder', recordId: 'self', schemaVersion: 1 },
			blob,
			ks,
			3
		).then((b) => JSON.parse(new TextDecoder().decode(b)) as unknown);
		await expect(opened).resolves.toEqual(baseRecord);
	});

	// A blob copied into another store's row (or the reverse) must not open: the store name is part of what the tag covers.
	it('fails auth for a blob bound to another store', async () => {
		const ks = baseKeystore();
		const plaintext = new TextEncoder().encode(JSON.stringify(baseRecord));
		const foreign = await encryptRecord(
			{ storeName: 'calendar-sync', recordId: 'self', schemaVersion: 1 },
			plaintext,
			ks,
			3
		);
		await expect(decryptFinderRecord(foreign, ks, 3)).rejects.toThrow(AesGcmAuthError);
	});

	it('fails auth when the generation does not match (replay/generation binding)', async () => {
		const ks = baseKeystore();
		const blob = await encryptFinderRecord(baseRecord, ks, 3);
		await expect(decryptFinderRecord(blob, ks, 4)).rejects.toThrow(AesGcmAuthError);
	});

	// The plaintext JSON holds the person's place, saved programs and filters in one buffer. The decoded record carries
	// its own strings, so the buffer has no use once decoding ends.
	describe('plaintext buffers', () => {
		it('wipes the decrypted buffer once it has been decoded', async () => {
			const ks = baseKeystore();
			const blob = await encryptFinderRecord(baseRecord, ks, 3);

			const dec = await decryptFinderRecord(blob, ks, 3);

			expect(seen.decoderInput).toHaveLength(1);
			expect(seen.decoderInputFull).toEqual([true]);
			expect(seen.decoderInput.every((b) => b.length > 0 && !hasData(b))).toBe(true);
			expect(dec.finderCompare).toEqual([386]);
		});

		it('wipes the decrypted buffer when decoding throws', async () => {
			const ks = baseKeystore();
			const wrongSchema = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2 }));
			const blob = await encryptRecord(
				{ storeName: 'skillbridge-finder', recordId: 'self', schemaVersion: 1 },
				wrongSchema,
				ks,
				3
			);

			await expect(decryptFinderRecord(blob, ks, 3)).rejects.toThrow(FinderSchemaError);

			expect(seen.decoderInput).toHaveLength(1);
			expect(seen.decoderInputFull).toEqual([true]);
			expect(seen.decoderInput.every((b) => b.length > 0 && !hasData(b))).toBe(true);
		});

		it('wipes the encoded record and the copy given to the cipher once encryption is done', async () => {
			const ks = baseKeystore();

			await encryptFinderRecord(baseRecord, ks, 3);

			expect(seen.encoded).toHaveLength(1);
			expect(seen.cipherInput).toHaveLength(1);
			// They held the record when the cipher was handed it, and still did when it finished, so the wipe came after
			// encryption and not before.
			expect(seen.encodedFull).toEqual([true]);
			expect(seen.cipherInputFullAtCall).toEqual([true]);
			expect(seen.cipherInputFullAtSettle).toEqual([true]);
			expect(seen.encoded.every((b) => b.length > 0 && !hasData(b))).toBe(true);
			expect(seen.cipherInput.every((b) => b.length > 0 && !hasData(b))).toBe(true);
			// The caller's own record is not the boundary's to wipe.
			expect(baseRecord.finderCompare).toEqual([386]);
		});
	});
});
