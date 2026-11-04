import type { StoreName } from '../db/schema';

/**
 * What a backup does with each store. Every store the app opens has a row, so a new store fails the type-check
 * until someone decides here whether a backup carries it.
 *
 * - carried: its decoded record goes into the file, and a restore replaces it.
 * - rewritten: a restore signs a fresh marker for it; nothing of it goes into the file.
 * - device-kept: belongs to this device alone; a restore only re-signs it.
 * - never: not read, not exported, not written by a restore (the person's own API key stays on the device, and so do
 *   the app lock's wrong tries and counter are this device's alone).
 */
export type BackupRole = 'carried' | 'rewritten' | 'device-kept' | 'never';

export const BACKUP_MANIFEST = {
	profile: 'carried',
	'timeline-state': 'carried',
	'calendar-sync': 'carried',
	'profile-hwm': 'rewritten',
	'timeline-state-hwm': 'rewritten',
	'calendar-sync-hwm': 'rewritten',
	keystore: 'device-kept',
	byok: 'never',
	'skillbridge-finder': 'never',
	'skillbridge-finder-hwm': 'never',
	'skillbridge-finder-pack': 'never',
	'app-lock': 'never'
} as const satisfies Record<StoreName, BackupRole>;

/** The stores whose records every backup file holds, in the order the file lists them. */
export const CARRIED_STORES = ['profile', 'timeline-state', 'calendar-sync'] as const;

/** Stores the app no longer has. A file from an older release may hold one; the check accepts it and drops it unread. */
export const RETIRED_STORES = ['skillbridge-finder'] as const;
