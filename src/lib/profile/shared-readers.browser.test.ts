import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openTestDb, deleteTestDb } from '../db/_test-helpers';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { KeystoreHmacMismatchError } from './store.svelte';
import { withStores, reqToPromise } from '../db/schema';
import { signSidecar, SidecarTamperError } from './sidecars';
import { createTimelineStateStore } from '../timeline/state.svelte';
import { createCalendarSyncStore } from '../calendar/store.svelte';
import { createByokStore } from '../ask/byok/store';

// The keystore row and the high-water marks are read by four stores through shared readers. The profile
// store's own tests tamper them through the profile store's path only, so a reader that stopped
// verifying would leave those green while the timeline, calendar and byok stores accepted forged rows.
// Each test here goes in through another store's entry point.

type Store = 'keystore' | 'byok' | 'timeline-state-hwm' | 'calendar-sync-hwm';
type HwmStore = 'timeline-state-hwm' | 'calendar-sync-hwm';
type Row = Record<string, unknown>;

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
});

afterEach(async () => {
	await deleteTestDb(db);
});

function readRow(store: Store): Promise<Row | undefined> {
	return withStores(db, store, 'readonly', (tx) =>
		reqToPromise<Row | undefined>(tx.objectStore(store).get(0))
	);
}

function putRow(store: 'keystore' | HwmStore, value: Row): Promise<void> {
	return withStores(db, store, 'readwrite', (tx) => {
		tx.objectStore(store).put(value);
	});
}

async function tamperKeystore(): Promise<void> {
	await bootstrapLocalKeystore(db);
	const ks = await readRow('keystore');
	if (!ks) throw new Error('test setup: keystore missing');
	await putRow('keystore', { ...ks, keystoreGeneration: 7 }); // a covered field, not re-signed
}

describe('a keystore whose record HMAC no longer verifies', () => {
	beforeEach(tamperKeystore);

	it('stops the timeline store load', async () => {
		await expect(createTimelineStateStore(db).load()).rejects.toThrow(KeystoreHmacMismatchError);
	});

	it('stops the calendar store load', async () => {
		await expect(createCalendarSyncStore(db).load()).rejects.toThrow(KeystoreHmacMismatchError);
	});

	it('stops byok readApiKey', async () => {
		await expect(createByokStore(db).readApiKey()).rejects.toThrow(KeystoreHmacMismatchError);
	});

	it('stops byok saveApiKey and writes nothing', async () => {
		await expect(createByokStore(db).saveApiKey('sk-ant-test')).rejects.toThrow(
			KeystoreHmacMismatchError
		);
		expect(await readRow('byok')).toBeUndefined();
	});
});

describe('a high-water mark whose MAC or payload is tampered', () => {
	const cases: { name: string; hwm: HwmStore; load: () => Promise<void> }[] = [
		{
			name: 'timeline-state-hwm',
			hwm: 'timeline-state-hwm',
			load: () => createTimelineStateStore(db).load()
		},
		{
			name: 'calendar-sync-hwm',
			hwm: 'calendar-sync-hwm',
			load: () => createCalendarSyncStore(db).load()
		}
	];

	// A signed generation-1 row, then one field changed after signing.
	async function putTampered(hwm: HwmStore, how: 'payload' | 'mac'): Promise<void> {
		const { record } = await bootstrapLocalKeystore(db);
		const signed = await signSidecar(
			hwm,
			{ generation: 1, keystoreGeneration: 0, epoch: 0, ts: 1716700000000 },
			record.hmacKeyRef
		);
		if (how === 'payload') {
			await putRow(hwm, { id: 0, ...signed, payload: { ...signed.payload, generation: 0 } });
		} else {
			const mac = new Uint8Array(signed.mac);
			mac[0] = (mac[0] ?? 0) ^ 0xff;
			await putRow(hwm, { id: 0, ...signed, mac: mac.buffer });
		}
	}

	for (const c of cases) {
		for (const how of ['payload', 'mac'] as const) {
			it(`${c.name}: a tampered ${how} is refused, not read as generation 0`, async () => {
				await putTampered(c.hwm, how);
				await expect(c.load()).rejects.toThrow(SidecarTamperError);
			});
		}
	}
});
