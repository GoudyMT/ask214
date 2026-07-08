import { describe, it, expect } from 'vitest';
import { buildAAD, computeKeystoreRecordHash, type AADParams } from './aad';
import type { KeystoreCanonicalInput } from '../keystore/record';

const baseInput = (): KeystoreCanonicalInput => ({
	v: 1,
	mode: 'local',
	keystoreGeneration: 0,
	epoch: 0,
	ivCounter: 0,
	installUuid: new Uint8Array(16).fill(1)
});

const baseParams = (recordHash: Uint8Array): AADParams => ({
	storeName: 'profile',
	recordId: 'self',
	keystoreGeneration: 0,
	generation: 5,
	schemaVersion: 1,
	keystoreRecordHash: recordHash
});

const hex = (b: Uint8Array): string =>
	Array.from(b)
		.map((x) => x.toString(16).padStart(2, '0'))
		.join('');

describe('buildAAD', () => {
	it('serializes exactly the 6 v1.0 fields in order', async () => {
		const rh = await computeKeystoreRecordHash(baseInput());
		const aStr = new TextDecoder().decode(buildAAD(baseParams(rh)));
		expect(aStr).toBe(`profile|self|0|5|sv1|${hex(rh)}`);
	});

	it('produces deterministic bytes for the same params', async () => {
		const rh = await computeKeystoreRecordHash(baseInput());
		expect(Array.from(buildAAD(baseParams(rh)))).toEqual(Array.from(buildAAD(baseParams(rh))));
	});

	it('changes when storeName changes', async () => {
		const rh = await computeKeystoreRecordHash(baseInput());
		const a = buildAAD(baseParams(rh));
		const b = buildAAD({ ...baseParams(rh), storeName: 'other' });
		expect(Array.from(a)).not.toEqual(Array.from(b));
	});

	it('changes when generation changes (closes cross-generation replay)', async () => {
		const rh = await computeKeystoreRecordHash(baseInput());
		const a = buildAAD({ ...baseParams(rh), generation: 5 });
		const b = buildAAD({ ...baseParams(rh), generation: 6 });
		expect(Array.from(a)).not.toEqual(Array.from(b));
	});

	it('changes when keystoreRecordHash changes (binds to keystore state)', async () => {
		const rh1 = await computeKeystoreRecordHash(baseInput());
		const rh2 = await computeKeystoreRecordHash({
			...baseInput(),
			installUuid: new Uint8Array(16).fill(2)
		});
		const a = buildAAD(baseParams(rh1));
		const b = buildAAD({ ...baseParams(rh1), keystoreRecordHash: rh2 });
		expect(Array.from(a)).not.toEqual(Array.from(b));
	});
});

describe('computeKeystoreRecordHash', () => {
	it('is 32 bytes (SHA-256)', async () => {
		const rh = await computeKeystoreRecordHash(baseInput());
		expect(rh.length).toBe(32);
	});

	it('EXCLUDES ivCounter (operational, not integrity-critical)', async () => {
		const a = await computeKeystoreRecordHash(baseInput());
		const b = await computeKeystoreRecordHash({ ...baseInput(), ivCounter: 999 });
		expect(Array.from(a)).toEqual(Array.from(b));
	});
});
