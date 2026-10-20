import { describe, expect, it } from 'vitest';
import { BACKUP_RELEASE_DATE, formatBackupDate } from './dates';

describe('formatBackupDate', () => {
	// A backup made with the clock set before the app existed has no date worth showing; it is labelled, never refused.
	it('a date before BACKUP_RELEASE_DATE formats as date unknown', () => {
		expect(formatBackupDate(BACKUP_RELEASE_DATE - 1)).toBe('date unknown');
		expect(formatBackupDate(0)).toBe('date unknown');
	});

	it('a date on or after BACKUP_RELEASE_DATE uses the Timeline date format', () => {
		// Late evening where the person is (the tests run in America/Los_Angeles): the UTC day is already Mar 6, but the
		// backup was made on Mar 5.
		expect(formatBackupDate(new Date(2027, 2, 5, 23, 30).getTime())).toBe('Mar 5, 2027');
		expect(formatBackupDate(BACKUP_RELEASE_DATE)).not.toBe('date unknown');
	});
});
