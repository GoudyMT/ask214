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

	it('carries exactly the profile, the timeline and the calendar, in that order', () => {
		expect(CARRIED_STORES).toEqual(['profile', 'timeline-state', 'calendar-sync']);
		expect(STORES.filter((s) => BACKUP_MANIFEST[s] === 'carried')).toEqual([...CARRIED_STORES]);
	});
});
