import { describe, expect, it } from 'vitest';
import { STORES } from '../db/schema';
import { BACKUP_MANIFEST, CARRIED_STORES } from './manifest';

describe('BACKUP_MANIFEST', () => {
	// A store added to the app without a decision here would otherwise be left out of a backup, or put into one,
	// without anyone choosing. The type-check covers the keys; this covers the values at run time.
	it('maps every store the app opens, and keeps the API key out of a backup', () => {
		expect(Object.keys(BACKUP_MANIFEST).sort()).toEqual([...STORES].sort());
		expect(BACKUP_MANIFEST.byok).toBe('never');
	});

	// Until a backup carries the finder's saved picks, a file must not hold them and a restore must not touch them.
	it('keeps the finder record, its marker and its data pack out of a backup', () => {
		expect(BACKUP_MANIFEST['skillbridge-finder']).toBe('never');
		expect(BACKUP_MANIFEST['skillbridge-finder-hwm']).toBe('never');
		expect(BACKUP_MANIFEST['skillbridge-finder-pack']).toBe('never');
	});

	it('carries exactly the profile, the timeline and the calendar, in that order', () => {
		expect(CARRIED_STORES).toEqual(['profile', 'timeline-state', 'calendar-sync']);
		expect(STORES.filter((s) => BACKUP_MANIFEST[s] === 'carried')).toEqual([...CARRIED_STORES]);
	});
});
