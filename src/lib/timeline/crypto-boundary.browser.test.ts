import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { encryptTimelineRecord, decryptTimelineRecord } from './crypto-boundary';
import { TimelineSchemaError } from './state-codec';
import { createTimelineStateStore } from './state.svelte';
import { encryptRecord, decryptRecord } from '../crypto/record-crypto';
import { AesGcmAuthError } from '../crypto/aes-gcm';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';
import type { TimelineState } from './types';
import type { KeystoreRecordV1 } from '../keystore/record';

// Passthrough seams that record the byte buffers the boundary hands to its collaborators, so a test can
// look at them after the call: what the encoder returned, the copy given to the cipher, and what the
// decoder was given. Each also notes whether the buffer still held data when it was handed over (and, for
// the cipher, when encryption settled), which keeps "all zero afterwards" from passing on an empty buffer.
// The boundary seam records the calls the store makes to it.
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
vi.mock('$lib/timeline/state-codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('./state-codec')>();
	return {
		...real,
		encodeTimelineState: (s: TimelineState) => {
			const out = real.encodeTimelineState(s);
			seen.encoded.push(out);
			seen.encodedFull.push(hasData(out));
			return out;
		},
		decodeTimelineState: (b: Uint8Array) => {
			seen.decoderInput.push(b);
			seen.decoderInputFull.push(hasData(b));
			return real.decodeTimelineState(b);
		}
	};
});

vi.mock('$lib/crypto/record-crypto', async (importOriginal) => {
	const real = await importOriginal<typeof import('../crypto/record-crypto')>();
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

vi.mock('$lib/timeline/crypto-boundary', async (importOriginal) => {
	const real = await importOriginal<typeof import('./crypto-boundary')>();
	return {
		...real,
		encryptTimelineRecord: (...args: Parameters<typeof real.encryptTimelineRecord>) => {
			seen.encryptGenerations.push(args[2]);
			return real.encryptTimelineRecord(...args);
		},
		decryptTimelineRecord: (...args: Parameters<typeof real.decryptTimelineRecord>) => {
			seen.decryptGenerations.push(args[2]);
			return real.decryptTimelineRecord(...args);
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

const baseState: TimelineState = {
	schemaVersion: 1,
	tasks: {
		'dd214-review': { status: 'done' },
		'skillbridge-plan': {
			status: 'snoozed',
			snoozeUntil: '2027-04-01',
			notes: 'ask the base office'
		}
	}
};

describe('timeline stores encrypt through their boundary', () => {
	it('saves and loads through the boundary pair, each once, at the record generation', async () => {
		const db = await openTestDb();
		await bootstrapLocalKeystore(db);

		const a = createTimelineStateStore(db);
		await a.load();
		await a.setStatus('dd214-review', 'done');

		expect(seen.encryptGenerations).toEqual([1]);
		// No record existed at the first load, so nothing was decrypted yet.
		expect(seen.decryptGenerations).toEqual([]);

		const b = createTimelineStateStore(db);
		await b.load();

		expect(seen.encryptGenerations).toEqual([1]);
		expect(seen.decryptGenerations).toEqual([1]);
		expect(b.state.tasks['dd214-review']?.status).toBe('done');
		await deleteTestDb(db);
	});
});

describe('encryptTimelineRecord / decryptTimelineRecord', () => {
	it('roundtrips a timeline state through encrypt + decrypt', async () => {
		const ks = baseKeystore();
		const blob = await encryptTimelineRecord(baseState, ks, 3);
		expect(await decryptTimelineRecord(blob, ks, 3)).toEqual(baseState);
	});

	// The bytes on disk are bound to this store name and record id by their AAD, so a later writer of this
	// record must produce what the store reads: pin the literal context, not just a self-consistent pair.
	it('writes a record bound to the timeline-state store context', async () => {
		const ks = baseKeystore();
		const blob = await encryptTimelineRecord(baseState, ks, 3);
		const opened = decryptRecord(
			{ storeName: 'timeline-state', recordId: 'self', schemaVersion: 1 },
			blob,
			ks,
			3
		).then((b) => JSON.parse(new TextDecoder().decode(b)) as unknown);
		await expect(opened).resolves.toEqual(baseState);
	});

	it('fails auth when the generation does not match (replay/generation binding)', async () => {
		const ks = baseKeystore();
		const blob = await encryptTimelineRecord(baseState, ks, 3);
		await expect(decryptTimelineRecord(blob, ks, 4)).rejects.toThrow(AesGcmAuthError);
	});

	// The plaintext JSON holds every status and note in one buffer. The decoded state carries its own
	// strings, so the buffer has no use once decoding ends.
	describe('plaintext buffers', () => {
		it('wipes the decrypted buffer once it has been decoded', async () => {
			const ks = baseKeystore();
			const blob = await encryptTimelineRecord(baseState, ks, 3);

			const dec = await decryptTimelineRecord(blob, ks, 3);

			expect(seen.decoderInput).toHaveLength(1);
			expect(seen.decoderInputFull).toEqual([true]);
			expect(seen.decoderInput.every((b) => b.length > 0 && !hasData(b))).toBe(true);
			expect(dec.tasks['skillbridge-plan']?.notes).toBe('ask the base office');
		});

		it('wipes the decrypted buffer when decoding throws', async () => {
			const ks = baseKeystore();
			const wrongSchema = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2 }));
			const blob = await encryptRecord(
				{ storeName: 'timeline-state', recordId: 'self', schemaVersion: 1 },
				wrongSchema,
				ks,
				3
			);

			await expect(decryptTimelineRecord(blob, ks, 3)).rejects.toThrow(TimelineSchemaError);

			expect(seen.decoderInput).toHaveLength(1);
			expect(seen.decoderInputFull).toEqual([true]);
			expect(seen.decoderInput.every((b) => b.length > 0 && !hasData(b))).toBe(true);
		});

		it('wipes the encoded state and the copy given to the cipher once encryption is done', async () => {
			const ks = baseKeystore();

			await encryptTimelineRecord(baseState, ks, 3);

			expect(seen.encoded).toHaveLength(1);
			expect(seen.cipherInput).toHaveLength(1);
			// They held the state when the cipher was handed it, and still did when it finished, so the wipe
			// came after encryption and not before.
			expect(seen.encodedFull).toEqual([true]);
			expect(seen.cipherInputFullAtCall).toEqual([true]);
			expect(seen.cipherInputFullAtSettle).toEqual([true]);
			expect(seen.encoded.every((b) => b.length > 0 && !hasData(b))).toBe(true);
			expect(seen.cipherInput.every((b) => b.length > 0 && !hasData(b))).toBe(true);
			// The caller's own state is not the boundary's to wipe.
			expect(baseState.tasks['skillbridge-plan']?.notes).toBe('ask the base office');
		});
	});
});
