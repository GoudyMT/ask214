import { describe, it, expect } from 'vitest';
import * as Profile from './index';

describe('profile public API (barrel)', () => {
	it('exposes the curated entry points', () => {
		expect(typeof Profile.createProfileStore).toBe('function');
		expect(typeof Profile.derivePersona).toBe('function');
		expect(typeof Profile.OccConflictError).toBe('function');
	});

	it('does not leak the private decrypted profile state', () => {
		expect(Profile).not.toHaveProperty('_profile');
		expect(Profile).not.toHaveProperty('_profileBytes');
	});
});
