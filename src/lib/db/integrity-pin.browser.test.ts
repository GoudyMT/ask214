import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProfileStore } from '../profile/store.svelte';
import { createTimelineStateStore } from '../timeline/state.svelte';
import { createCalendarSyncStore } from '../calendar/store.svelte';
import { createByokStore } from '../ask/byok/store';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { DB_VERSION, withStores } from './schema';
import { deleteTestDb, openTestDb } from './_test-helpers';

/**
 * The pin: rows written ONCE by an earlier build, read back through each store's real load path. What the stores sign
 * (the key record's HMAC input, a sidecar's signed bytes) and authenticate (the AAD of every body) is fixed by these
 * bytes. If a change to that code makes a row below fail its check, the same change would make a real user's saved data
 * read as damaged and offer to erase it - so this test fails first.
 *
 * Every value is a literal. None is computed here by the code under test. Change any of these bytes and raise
 * DB_VERSION (schema.ts): an older app must stop at the version, never read the newer data as damaged.
 */

const GOLDEN = {
	// Raw key material for the fixed CryptoKeys: bytes 0x00..0x1f (AES-GCM) and 0xa0..0xbf (HMAC-SHA-256).
	aesKey: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
	hmacKey: 'a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf',
	installUuid: '404142434445464748494a4b4c4d4e4f',
	recordHmac: '21061024a1437c1e2f16f624c22b9114a534fbcda209331420f807958f495e23',
	profileHwmMac: '281ce22a94ada0c316291be76431cd22d90d71dbcbd32c5e781eb32271c9dae0',
	timelineHwmMac: '918f9da4351eacff1508629ce2c8f02a0c6dff6317068475ff2f4a0c78c42de2',
	calendarHwmMac: 'ff32b6036d50c33f171bf27ccf15c3cfb575685875e5bf5688a1677c0d48f86d',
	profileBlob:
		'101112131415161718191a1b06dcfd7726ba1889e838625c76371063a01d1d3e638c068cdadbce4539313abe2288236a9ac84cd54d1ab03debeb674876d9293297a963c38b2e0a01c3a7945b35c80f13659c795519e517c4fa92beef009bbe8f15fe3a5fed91767a9cf78a7a122574879e8808f41a7ca13a0209b7fc21e8d2048bd0948fda9baf861b90d439eea6b05306abaf9712d9f290d4a82a18ca47292974e3fad79ee47abdbcc5dd1af4e7bf61ac81f4c089015eddc25d13348008d381d118c94830f6943993120985f209443c3c4a69',
	timelineBlob:
		'303132333435363738393a3bc81742a3810a27627c56fc9f7bf6504aa6166375b75f376e549c6b37cac71f4d284d6d4616bbb9d4da45663c09e4e90fca23332c09cce905d921123f6d2a73ce2b44cdfbf5dd424cd221bb25080013ba59bd122fa1b67cb06a9c5ee70d247684e98d742b604a31206e90366035d5943d1d102f2a3b6b00ca082b9ed83027129fd168ff76c22f4a2fc0d62e5998bab352397dcf270a238ef9026f720b5f84eaffc502571e78ad',
	calendarBlob:
		'505152535455565758595a5be90545178c35d4870ad34f16a48eedf7d91ed1c94709f94e51fa89b49e33b74e2acdfebc184ddad01af8dfc5f7f698a4ba06173b7731700efeb28163c0bb6df74348e6c1ab9e72154b948563bc1b376fa59efe7590d43c17d21f24b27379ff75c2c01bb678c6c012271e09c25a563e6cd6602138e5296d2089a5bd0eeef8e4e9ba9bbc2e7d734e64adad6a01a8a1386c7d0028da4ebbce361dd9c9c0dad71f97f659cd6da2e5b659ee54626b5648b4a00e14aa941c8e40abbee4b3775e22f33ff5888f8db5a64f90de0f9e638a4f666ea99f655a79c79100b6732a701efc0faa63f09183e56a1feb8afae3ca308aaf8fd21914d15bff4df1f81a8ee6f38908c7a4f2e9ba82145318ead356b78561f951b3',
	byokBlob:
		'707172737475767778797a7b71eec253c6bbf919255a5fffba25c8fac358b1a076fe2dd6dc0b259c800e33170fb46a6859ae93e2'
};

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function macBuffer(hex: string): ArrayBuffer {
	return fromHex(hex).buffer;
}

const enc = (s: string) => new TextEncoder().encode(s);

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
	const dataKeyRef = await crypto.subtle.importKey(
		'raw',
		fromHex(GOLDEN.aesKey),
		{ name: 'AES-GCM' },
		false,
		['encrypt', 'decrypt']
	);
	const hmacKeyRef = await crypto.subtle.importKey(
		'raw',
		fromHex(GOLDEN.hmacKey),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	);
	await withStores(
		db,
		[
			'keystore',
			'profile',
			'profile-hwm',
			'timeline-state',
			'timeline-state-hwm',
			'calendar-sync',
			'calendar-sync-hwm',
			'byok'
		],
		'readwrite',
		(tx) => {
			tx.objectStore('keystore').put({
				id: 0,
				v: 1,
				mode: 'local',
				keystoreGeneration: 2,
				epoch: 3,
				ivCounter: 5,
				installUuid: fromHex(GOLDEN.installUuid),
				dataKeyRef,
				hmacKeyRef,
				recordHmac: macBuffer(GOLDEN.recordHmac)
			});
			tx.objectStore('profile-hwm').put({
				id: 0,
				v: 1,
				payload: { generation: 3, keystoreGeneration: 2, epoch: 3, ts: 1700000003000 },
				mac: macBuffer(GOLDEN.profileHwmMac)
			});
			tx.objectStore('timeline-state-hwm').put({
				id: 0,
				v: 1,
				payload: { generation: 4, keystoreGeneration: 2, epoch: 3, ts: 1700000004000 },
				mac: macBuffer(GOLDEN.timelineHwmMac)
			});
			tx.objectStore('calendar-sync-hwm').put({
				id: 0,
				v: 1,
				payload: { generation: 5, keystoreGeneration: 2, epoch: 3, ts: 1700000005000 },
				mac: macBuffer(GOLDEN.calendarHwmMac)
			});
			tx.objectStore('profile').put({ id: 0, rec: fromHex(GOLDEN.profileBlob) });
			tx.objectStore('timeline-state').put({ id: 0, rec: fromHex(GOLDEN.timelineBlob) });
			tx.objectStore('calendar-sync').put({ id: 0, rec: fromHex(GOLDEN.calendarBlob) });
			tx.objectStore('byok').put({ id: 0, rec: fromHex(GOLDEN.byokBlob) });
		}
	);
});

afterEach(async () => {
	await deleteTestDb(db);
});

describe('integrity pin: rows an earlier build wrote are read by the real load path', () => {
	it('reads the profile', async () => {
		const loaded = await createProfileStore(db).load();
		expect(loaded).toEqual({
			schemaVersion: 1,
			generation: 3,
			lastSeenAt: 1700000000000,
			setupIntent: 'completed',
			setupIntentChangedAt: 1700000001000,
			eaos: enc('2027-01-15'),
			rate: enc('IT'),
			yearsOfService: 8
		});
	});

	it('reads the timeline state', async () => {
		const store = createTimelineStateStore(db);
		await store.load();
		expect(store.state).toEqual({
			schemaVersion: 1,
			tasks: {
				'task-a': { status: 'done' },
				'task-b': { status: 'snoozed', snoozeUntil: '2026-09-01' },
				'task-c': { notes: 'call the office' }
			}
		});
	});

	it('reads the calendar sync state', async () => {
		const store = createCalendarSyncStore(db);
		await store.load();
		expect(store.exclusions).toEqual({ taskIds: ['task-a'], categories: ['medical'] });
		expect(store.card).toEqual({ dismissedAt: 1700000002000, dismissCount: 1 });
		expect(store.lastAdd).toEqual([
			{
				taskId: 'task-b',
				moment: 'opens',
				title: 'Book the physical',
				isoDate: '2026-09-01',
				addedOn: '2026-08-20'
			}
		]);
	});

	// The golden rows above do not pass through bootstrap, which signs the first high-water mark itself: a name it signs
	// that load does not verify would turn every new install's first start into "damaged".
	it('reads a freshly set up keystore as a first run', async () => {
		const fresh = await openTestDb();
		try {
			await bootstrapLocalKeystore(fresh);
			expect(await createProfileStore(fresh).load()).toBeNull();
		} finally {
			await deleteTestDb(fresh);
		}
	});

	it('reads the stored API key', async () => {
		expect(await createByokStore(db).readApiKey()).toBe('fixture-api-key-not-real');
	});

	// The version is what keeps an older app from reading these bytes as damaged once they change.
	it('is still database version 6', () => {
		expect(DB_VERSION).toBe(6);
	});
});
