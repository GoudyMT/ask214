import { decryptCalendarRecord } from '../calendar/crypto-boundary';
import type { CalendarSyncState } from '../calendar/types';
import { withWriteLocks } from '../db/locks';
import { reqToPromise, withStores, type StoreName } from '../db/schema';
import { verifyRecordHmac, type KeystoreRecordV1 } from '../keystore/record';
import { decryptProfileRecord } from '../profile/crypto-boundary';
import { zeroizeRecord } from '../profile/lifecycle';
import { verifySidecar, type SignedSidecar } from '../profile/sidecars';
import type { ProfileV1 } from '../profile/types';
import { decryptTimelineRecord } from '../timeline/crypto-boundary';
import type { TimelineState } from '../timeline/types';
import type { RefusedStore } from './validate';

/**
 * What a backup is made from: the three records the person saved on this device, read straight from storage and
 * decoded. `gens` are the three sidecar generations the records were read at (0 for a record never written); the
 * export's backup mark is built from them.
 *
 * The caller owns the decoded profile, whose date fields are byte arrays: wipe them with `zeroizeRecord` when the
 * export is done, on every path. The plaintext each body was decrypted into is already wiped inside the decrypt
 * step, so nothing else of this read stays in memory as bytes.
 */
export type Snapshot = {
	ok: true;
	profile: ProfileV1;
	timeline: TimelineState | null;
	calendar: CalendarSyncState | null;
	gens: { profile: number; timeline: number; calendar: number };
};

export type SnapshotResult =
	| Snapshot
	| { ok: false; code: 'E_BACKUP_UNAVAILABLE' }
	| { ok: false; code: 'E_SNAPSHOT_FAILED'; store: RefusedStore };

type KeystoreRow = KeystoreRecordV1 & { id: number };
type BodyRow = { id: number; rec: Uint8Array };
type MarkRow = SignedSidecar<{ generation: number }>;

// byok is never read: a backup does not carry the person's own API key.
const SNAPSHOT_STORES: StoreName[] = [
	'profile',
	'profile-hwm',
	'keystore',
	'timeline-state',
	'timeline-state-hwm',
	'calendar-sync',
	'calendar-sync-hwm'
];

const failed = (store: RefusedStore): SnapshotResult => ({
	ok: false,
	code: 'E_SNAPSHOT_FAILED',
	store
});

const refuse = () => new Error('E_SNAPSHOT_FAILED');

/** The generation a sidecar vouches for, or null when no sidecar row exists. A row that does not verify throws. */
async function generationOf(
	name: string,
	mark: MarkRow | undefined,
	key: CryptoKey
): Promise<number | null> {
	if (!mark) return null;
	const payload = await verifySidecar<{ generation: number }>(
		name,
		{ v: 1, payload: mark.payload, mac: mark.mac },
		key
	);
	return payload.generation;
}

/**
 * A store that may never have been written. No body and no sidecar is a record that does not exist yet. A body with no
 * sidecar would read as "nothing written" and export an empty record over real data, and a sidecar that vouches for a
 * generation with no body is a record that was lost, so both throw.
 */
async function readOptional<T>(
	name: string,
	body: BodyRow | undefined,
	mark: MarkRow | undefined,
	keystore: KeystoreRow,
	decrypt: (blob: Uint8Array, keystore: KeystoreRecordV1, generation: number) => Promise<T>
): Promise<{ state: T | null; gen: number }> {
	const gen = await generationOf(name, mark, keystore.hmacKeyRef);
	if (gen === null) {
		if (body) throw refuse();
		return { state: null, gen: 0 };
	}
	if (!body) {
		if (gen > 0) throw refuse();
		return { state: null, gen: 0 };
	}
	return { state: await decrypt(body.rec, keystore, gen), gen };
}

async function readCut(db: IDBDatabase): Promise<SnapshotResult> {
	let cut;
	try {
		// Seven gets issued together in one readonly transaction: IndexedDB shows it a single state, so a write
		// landing from another tab is wholly before or wholly after what is read here. Verifying and decrypting wait
		// until the transaction has finished, because IndexedDB commits one that idles while the code awaits.
		cut = await withStores(db, SNAPSHOT_STORES, 'readonly', (tx) => {
			const get = <T>(store: StoreName) =>
				reqToPromise<T | undefined>(tx.objectStore(store).get(0));
			return Promise.all([
				get<KeystoreRow>('keystore'),
				get<BodyRow>('profile'),
				get<MarkRow>('profile-hwm'),
				get<BodyRow>('timeline-state'),
				get<MarkRow>('timeline-state-hwm'),
				get<BodyRow>('calendar-sync'),
				get<MarkRow>('calendar-sync-hwm')
			]);
		});
	} catch {
		return failed('profile');
	}
	const [
		keystore,
		profileBody,
		profileMark,
		timelineBody,
		timelineMark,
		calendarBody,
		calendarMark
	] = cut;

	let profile: ProfileV1 | null = null;
	let handedOver = false;
	let at: RefusedStore = 'profile';
	try {
		if (
			!keystore ||
			!keystore.recordHmac ||
			!(await verifyRecordHmac(keystore, keystore.hmacKeyRef, keystore.recordHmac))
		) {
			throw refuse();
		}
		const profileGen = await generationOf('profile-hwm', profileMark, keystore.hmacKeyRef);
		// No sidecar row at all is a damaged device; generation 0 is a device that was never set up.
		if (profileGen === null) throw refuse();
		if (profileGen === 0) return { ok: false, code: 'E_BACKUP_UNAVAILABLE' };
		if (!profileBody) throw refuse();
		profile = await decryptProfileRecord(profileBody.rec, keystore, profileGen);
		if (profile.setupIntent !== 'completed') return { ok: false, code: 'E_BACKUP_UNAVAILABLE' };

		at = 'timeline';
		const timeline = await readOptional(
			'timeline-state-hwm',
			timelineBody,
			timelineMark,
			keystore,
			decryptTimelineRecord
		);
		at = 'calendar';
		const calendar = await readOptional(
			'calendar-sync-hwm',
			calendarBody,
			calendarMark,
			keystore,
			decryptCalendarRecord
		);
		handedOver = true;
		return {
			ok: true,
			profile,
			timeline: timeline.state,
			calendar: calendar.state,
			gens: { profile: profileGen, timeline: timeline.gen, calendar: calendar.gen }
		};
	} catch {
		return failed(at);
	} finally {
		// A profile decoded for a read that then failed is no one's to keep.
		if (profile && !handedOver) zeroizeRecord(profile as unknown as Record<string, unknown>);
	}
}

/**
 * Reads the device's saved profile, timeline and calendar for a backup, from storage and never from what the screen
 * holds, so a screen that locked itself does not hide the person's data from their own backup.
 *
 * Under the write locks (so no save of this tab or another lands mid-read) it takes one consistent cut of the seven
 * stores, then checks the key record's MAC and every sidecar's MAC and decrypts each body at the generation its sidecar
 * vouches for. Only raw helpers run under the lock: a store's own load or save would take the same non-reentrant lock,
 * and a bus publish would tell other tabs something changed.
 *
 * Refuses with E_BACKUP_UNAVAILABLE when the setup is not finished, and with E_SNAPSHOT_FAILED naming the first store
 * that could not be read, checked or decoded (a failure of the key record names the profile). A run signal that aborts
 * before the lock is granted rejects with the lock helper's own error.
 */
export function takeSnapshot(db: IDBDatabase, signal?: AbortSignal): Promise<SnapshotResult> {
	// The generation the helper loads is for writers that compare it; a read has nothing to compare.
	return withWriteLocks(
		() => Promise.resolve(0),
		() => readCut(db),
		undefined,
		signal
	);
}
