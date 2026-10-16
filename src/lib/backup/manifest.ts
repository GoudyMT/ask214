import type { StoreName } from '../db/schema';

/**
 * What a backup does with each store. Every store the app opens has a row, so a new store fails the type-check
 * until someone decides here whether a backup carries it.
 *
 * - carried: its decoded record goes into the file, and a restore replaces it.
 * - rewritten: a restore signs a fresh marker for it; nothing of it goes into the file.
 * - device-kept: belongs to this device alone; a restore only re-signs it.
 * - never: not read, not exported, not written by a restore (the person's own API key stays on the device).
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
	byok: 'never'
} as const satisfies Record<StoreName, BackupRole>;

/** The stores whose records a backup file holds, in the order the file lists them. */
export const CARRIED_STORES = ['profile', 'timeline-state', 'calendar-sync'] as const;
