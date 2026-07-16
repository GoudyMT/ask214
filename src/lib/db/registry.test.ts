import { describe, it, expect } from 'vitest';
import { ENCRYPTED_STORES, isEncryptedStore } from './registry';
import { STORES, DB_VERSION } from './schema';

describe('ENCRYPTED_STORES registry', () => {
	it('enumerates all encrypted stores for v1.0', () => {
		expect(ENCRYPTED_STORES).toEqual(['profile', 'timeline-state', 'calendar-sync']);
	});

	it('isEncryptedStore returns true for registered stores', () => {
		expect(isEncryptedStore('profile')).toBe(true);
		expect(isEncryptedStore('timeline-state')).toBe(true);
	});

	it('isEncryptedStore returns false for unregistered stores', () => {
		expect(isEncryptedStore('keystore')).toBe(false);
		expect(isEncryptedStore('profile-hwm')).toBe(false);
		expect(isEncryptedStore('timeline-state-hwm')).toBe(false);
		expect(isEncryptedStore('journal')).toBe(false);
		expect(isEncryptedStore('meta')).toBe(false);
	});

	it('registry is frozen (compile-time and runtime)', () => {
		expect(Object.isFrozen(ENCRYPTED_STORES)).toBe(true);
	});

	it('registers the calendar-sync store as encrypted and in the schema at DB_VERSION 3', () => {
		expect(STORES).toContain('calendar-sync');
		expect(STORES).toContain('calendar-sync-hwm');
		expect(ENCRYPTED_STORES).toContain('calendar-sync');
		expect(DB_VERSION).toBe(3);
	});
});
