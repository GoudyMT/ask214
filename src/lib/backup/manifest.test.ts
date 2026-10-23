import { describe, expect, it } from 'vitest';
import { STORES } from '../db/schema';
import { BACKUP_MANIFEST, CARRIED_STORES, OPTIONAL_CARRIED_STORES } from './manifest';

describe('BACKUP_MANIFEST', () => {
	// A store added to the app without a decision here would otherwise be left out of a backup, or put into one,
	// without anyone choosing. The type-check covers the keys; this covers the values at run time.
	it('maps every store the app opens, and keeps the API key out of a backup', () => {
		expect(Object.keys(BACKUP_MANIFEST).sort()).toEqual([...STORES].sort());
		expect(BACKUP_MANIFEST.byok).toBe('never');
	});

	// The finder's saved picks travel; the cached listings and the ids the person opened are public data kept on this
	// device alone, and a restore only drops them.
	it('carries the finder record, rewrites its marker, and keeps its data pack out of a backup', () => {
		expect(BACKUP_MANIFEST['skillbridge-finder']).toBe('carried');
		expect(BACKUP_MANIFEST['skillbridge-finder-hwm']).toBe('rewritten');
		expect(BACKUP_MANIFEST['skillbridge-finder-pack']).toBe('never');
	});

	it('requires exactly the profile, the timeline and the calendar, in that order, and allows the finder', () => {
		expect(CARRIED_STORES).toEqual(['profile', 'timeline-state', 'calendar-sync']);
		expect(OPTIONAL_CARRIED_STORES).toEqual(['skillbridge-finder']);
		expect(STORES.filter((s) => BACKUP_MANIFEST[s] === 'carried')).toEqual([
			...CARRIED_STORES,
			...OPTIONAL_CARRIED_STORES
		]);
	});
});
