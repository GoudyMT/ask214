import { describe, it, expect, beforeEach } from 'vitest';
import {
	isOnlineConsented,
	setOnlineConsented,
	getDefaultMode,
	setDefaultMode,
	isSynthesisEnabled,
	setSynthesisEnabled
} from './online-prefs';

describe('online-prefs (non-PII device flags)', () => {
	beforeEach(() => localStorage.clear());

	it('defaults: not consented, online mode (the on-ramp default), synthesis off', () => {
		expect(isOnlineConsented()).toBe(false);
		expect(getDefaultMode()).toBe('online');
		expect(isSynthesisEnabled()).toBe(false);
	});

	it('round-trips each flag through localStorage', () => {
		setOnlineConsented(true);
		setDefaultMode('device'); // the non-default, so this proves the write actually happened
		setSynthesisEnabled(true);
		expect(isOnlineConsented()).toBe(true);
		expect(getDefaultMode()).toBe('device');
		expect(isSynthesisEnabled()).toBe(true);
	});
});
