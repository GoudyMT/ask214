import type { ProfileV1 } from './types';
import { keyIdentity, verifyKeystore } from '../keystore/record';
import {
	KeystoreHmacMismatchError,
	KeystoreNotInitializedError,
	checkSessionCounter,
	keysForRow,
	type KeystoreRow
} from '../keystore/read';
import { KeystoreLockedError } from '../keystore/session';
import { decryptProfileRecord } from './crypto-boundary';
import { verifySidecar, type SignedSidecar } from './sidecars';
import { withStores, reqToPromise, type StoreName } from '../db/schema';
import { zeroizeRecord } from './lifecycle';
import type { HwmRow, ProfileRow } from './store.svelte';

/**
 * Kept out of store.svelte.ts on purpose: only the backup and restore flows read the device's saved state, and the
 * profile store loads on every page.
 */

/** What readDeviceState returns; a time is null for a sidecar that was never written. */
export type DeviceState = {
	gens: { profile: number; timeline: number; calendar: number; finder: number };
	ts: {
		profile: number | null;
		timeline: number | null;
		calendar: number | null;
		finder: number | null;
	};
	mark: {
		at: number;
		gens: { profile: number; timeline: number; calendar: number; finder: number };
	} | null;
	lastSeenAt: number | null;
};

const DEVICE_STATE_STORES: StoreName[] = [
	'keystore',
	'profile',
	'profile-hwm',
	'timeline-state-hwm',
	'calendar-sync-hwm',
	'skillbridge-finder-hwm'
];

type GenerationHwmRow = SignedSidecar<{ generation: number; ts: number }>;

/**
 * One verified snapshot of the device's saved state: the profile, timeline, calendar and finder generations and write
 * times, the backup mark the profile holds (when the last backup was made or restored, and the four generations it
 * matched), and the profile's last-seen time. A later restore compares these to say whether the device holds changes
 * newer than a backup. A mark made before the finder existed has no finder generation; it reads as 0, the finder
 * being empty then.
 *
 * The six rows are read in ONE readonly transaction. IndexedDB shows a readonly transaction a single state, so the
 * rows are a consistent cut with no lock: a write landing between two separate reads could pair a profile of one
 * moment with a timeline of another. Verifying and decrypting wait until the transaction has finished, because
 * IndexedDB commits a transaction that idles while the code awaits anything else.
 *
 * The profile is decrypted only for a few numbers (the mark's fields and lastSeenAt). The decoded record is
 * zeroized at once, on every path, so the plaintext the caller never asked for does not outlive the call.
 *
 * Throws E_RESTORE_DEVICE_DAMAGED when any row fails its check (the key record's MAC, a sidecar's MAC, the profile's
 * decrypt or schema) or the profile's high-water mark says a body was saved and none is there. A missing key record throws
 * KeystoreNotInitializedError instead: that device holds no saved state at all, which is not damage.
 */
export async function readDeviceState(db: IDBDatabase): Promise<DeviceState> {
	const [ks, profileRow, profileHwmRow, timelineHwmRow, calendarHwmRow, finderHwmRow] =
		await withStores(db, DEVICE_STATE_STORES, 'readonly', (tx) => {
			const get = <T>(store: StoreName) =>
				reqToPromise<T | undefined>(tx.objectStore(store).get(0));
			return Promise.all([
				get<KeystoreRow>('keystore'),
				get<ProfileRow>('profile'),
				get<HwmRow>('profile-hwm'),
				get<GenerationHwmRow>('timeline-state-hwm'),
				get<GenerationHwmRow>('calendar-sync-hwm'),
				get<GenerationHwmRow>('skillbridge-finder-hwm')
			]);
		});
	if (!ks) throw new KeystoreNotInitializedError();

	let decoded: ProfileV1 | null = null;
	try {
		const keys = keysForRow(ks);
		// After the transaction above has finished, so the counter read opens its own.
		await checkSessionCounter(db);
		if (!(await verifyKeystore(ks, keys))) throw new KeystoreHmacMismatchError();
		// A sidecar that was never written reads as generation 0 with no time; one that is there must verify.
		const verified = async (
			store: 'profile-hwm' | 'timeline-state-hwm' | 'calendar-sync-hwm' | 'skillbridge-finder-hwm',
			row: { payload: { generation: number; ts: number }; mac: ArrayBuffer } | undefined
		): Promise<{ generation: number; ts: number | null }> => {
			if (!row) return { generation: 0, ts: null };
			const payload = await verifySidecar(
				store,
				{ v: 1, payload: row.payload, mac: row.mac },
				keys.hmacKey
			);
			return { generation: payload.generation, ts: payload.ts };
		};
		const profile = await verified('profile-hwm', profileHwmRow);
		const timeline = await verified('timeline-state-hwm', timelineHwmRow);
		const calendar = await verified('calendar-sync-hwm', calendarHwmRow);
		const finder = await verified('skillbridge-finder-hwm', finderHwmRow);

		let mark: DeviceState['mark'] = null;
		let lastSeenAt: number | null = null;
		if (profile.generation >= 1) {
			if (!profileRow) throw new Error('E_PROFILE_BODY_MISSING');
			decoded = await decryptProfileRecord(
				profileRow.rec,
				keyIdentity(ks),
				keys.dataKey,
				profile.generation
			);
			lastSeenAt = decoded.lastSeenAt;
			const {
				lastBackupAt,
				backupGenProfile,
				backupGenTimeline,
				backupGenCalendar,
				backupGenFinder
			} = decoded;
			// Some of the four older fields without all of them is no mark: a backup is vouched for whole or not at all.
			// The finder's is the fifth and may be missing (a mark from before the finder existed), which reads as 0.
			if (
				lastBackupAt !== undefined &&
				backupGenProfile !== undefined &&
				backupGenTimeline !== undefined &&
				backupGenCalendar !== undefined
			) {
				mark = {
					at: lastBackupAt,
					gens: {
						profile: backupGenProfile,
						timeline: backupGenTimeline,
						calendar: backupGenCalendar,
						finder: backupGenFinder ?? 0
					}
				};
			}
		}
		return {
			gens: {
				profile: profile.generation,
				timeline: timeline.generation,
				calendar: calendar.generation,
				finder: finder.generation
			},
			ts: { profile: profile.ts, timeline: timeline.ts, calendar: calendar.ts, finder: finder.ts },
			mark,
			lastSeenAt
		};
	} catch (e) {
		// A tab that locked in the middle of this read holds good data it cannot open right now: damage offers an erase.
		if (e instanceof KeystoreLockedError) throw e;
		throw new Error('E_RESTORE_DEVICE_DAMAGED', { cause: e });
	} finally {
		if (decoded) zeroizeRecord(decoded as unknown as Record<string, unknown>);
	}
}
