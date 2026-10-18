import type { ProfileV1 } from './types';
import { verifyRecordHmac } from '../keystore/record';
import { decryptProfileRecord } from './crypto-boundary';
import { verifySidecar, type SignedSidecar } from './sidecars';
import { withStores, reqToPromise, type StoreName } from '../db/schema';
import { zeroizeRecord } from './lifecycle';
import {
	KeystoreHmacMismatchError,
	KeystoreNotInitializedError,
	type HwmRow,
	type KeystoreRow,
	type ProfileRow
} from './store.svelte';

/**
 * Kept out of store.svelte.ts on purpose: only the backup and restore flows read the device's saved state, and the
 * profile store loads on every page.
 */

/** What readDeviceState returns; a time is null for a sidecar that was never written. */
export type DeviceState = {
	gens: { profile: number; timeline: number; calendar: number };
	ts: { profile: number | null; timeline: number | null; calendar: number | null };
	mark: { at: number; gens: { profile: number; timeline: number; calendar: number } } | null;
	lastSeenAt: number | null;
};

const DEVICE_STATE_STORES: StoreName[] = [
	'keystore',
	'profile',
	'profile-hwm',
	'timeline-state-hwm',
	'calendar-sync-hwm'
];

type GenerationHwmRow = SignedSidecar<{ generation: number; ts: number }>;

/**
 * One verified snapshot of the device's saved state: the profile, timeline and calendar generations and write times,
 * the backup mark the profile holds (when the last backup was made or restored, and the three generations it
 * matched), and the profile's last-seen time. A later restore compares these to say whether the device holds changes
 * newer than a backup.
 *
 * The five rows are read in ONE readonly transaction. IndexedDB shows a readonly transaction a single state, so the
 * rows are a consistent cut with no lock: a write landing between two separate reads could pair a profile of one
 * moment with a timeline of another. Verifying and decrypting wait until the transaction has finished, because
 * IndexedDB commits a transaction that idles while the code awaits anything else.
 *
 * The profile is decrypted only for five numbers (the mark's four fields and lastSeenAt). The decoded record is
 * zeroized at once, on every path, so the plaintext the caller never asked for does not outlive the call.
 *
 * Throws E_RESTORE_DEVICE_DAMAGED when any row fails its check (the key record's MAC, a sidecar's MAC, the profile's
 * decrypt or schema) or the profile's high-water mark says a body was saved and none is there. A missing key record throws
 * KeystoreNotInitializedError instead: that device holds no saved state at all, which is not damage.
 */
export async function readDeviceState(db: IDBDatabase): Promise<DeviceState> {
	const [ks, profileRow, profileHwmRow, timelineHwmRow, calendarHwmRow] = await withStores(
		db,
		DEVICE_STATE_STORES,
		'readonly',
		(tx) => {
			const get = <T>(store: StoreName) =>
				reqToPromise<T | undefined>(tx.objectStore(store).get(0));
			return Promise.all([
				get<KeystoreRow>('keystore'),
				get<ProfileRow>('profile'),
				get<HwmRow>('profile-hwm'),
				get<GenerationHwmRow>('timeline-state-hwm'),
				get<GenerationHwmRow>('calendar-sync-hwm')
			]);
		}
	);
	if (!ks) throw new KeystoreNotInitializedError();

	let decoded: ProfileV1 | null = null;
	try {
		if (!ks.recordHmac || !(await verifyRecordHmac(ks, ks.hmacKeyRef, ks.recordHmac))) {
			throw new KeystoreHmacMismatchError();
		}
		// A sidecar that was never written reads as generation 0 with no time; one that is there must verify.
		const verified = async (
			store: 'profile-hwm' | 'timeline-state-hwm' | 'calendar-sync-hwm',
			row: { payload: { generation: number; ts: number }; mac: ArrayBuffer } | undefined
		): Promise<{ generation: number; ts: number | null }> => {
			if (!row) return { generation: 0, ts: null };
			const payload = await verifySidecar(
				store,
				{ v: 1, payload: row.payload, mac: row.mac },
				ks.hmacKeyRef
			);
			return { generation: payload.generation, ts: payload.ts };
		};
		const profile = await verified('profile-hwm', profileHwmRow);
		const timeline = await verified('timeline-state-hwm', timelineHwmRow);
		const calendar = await verified('calendar-sync-hwm', calendarHwmRow);

		let mark: DeviceState['mark'] = null;
		let lastSeenAt: number | null = null;
		if (profile.generation >= 1) {
			if (!profileRow) throw new Error('E_PROFILE_BODY_MISSING');
			decoded = await decryptProfileRecord(profileRow.rec, ks, profile.generation);
			lastSeenAt = decoded.lastSeenAt;
			const { lastBackupAt, backupGenProfile, backupGenTimeline, backupGenCalendar } = decoded;
			// Some of the four without all of them is no mark: a backup is vouched for whole or not at all.
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
						calendar: backupGenCalendar
					}
				};
			}
		}
		return {
			gens: {
				profile: profile.generation,
				timeline: timeline.generation,
				calendar: calendar.generation
			},
			ts: { profile: profile.ts, timeline: timeline.ts, calendar: calendar.ts },
			mark,
			lastSeenAt
		};
	} catch {
		throw new Error('E_RESTORE_DEVICE_DAMAGED');
	} finally {
		if (decoded) zeroizeRecord(decoded as unknown as Record<string, unknown>);
	}
}
