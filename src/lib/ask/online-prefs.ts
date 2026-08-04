// Non-PII device-capability flags (no query, no profile, nothing personal), so plain localStorage is correct
// here - the encrypted-IDB rule governs PII, which these are not. Kept in one module so the route and the
// Settings panel share the exact keys instead of duplicating string literals.
const CONSENTED_KEY = 'mtc:ask:online-consented';
const DEFAULT_MODE_KEY = 'mtc:ask:default-mode';
const SYNTHESIS_KEY = 'mtc:ask:synthesis-enabled';

function read(key: string): boolean {
	return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1';
}

function write(key: string, on: boolean): void {
	if (typeof localStorage !== 'undefined') {
		if (on) localStorage.setItem(key, '1');
		else localStorage.removeItem(key);
	}
}

/** Has the user consented to online egress on this device? */
export function isOnlineConsented(): boolean {
	return read(CONSENTED_KEY);
}

export function setOnlineConsented(on: boolean): void {
	write(CONSENTED_KEY, on);
}

/** The user's chosen default answer mode; 'device' unless they explicitly picked 'online'. */
export function getDefaultMode(): 'device' | 'online' {
	return typeof localStorage !== 'undefined' && localStorage.getItem(DEFAULT_MODE_KEY) === 'online'
		? 'online'
		: 'device';
}

export function setDefaultMode(mode: 'device' | 'online'): void {
	if (typeof localStorage !== 'undefined') localStorage.setItem(DEFAULT_MODE_KEY, mode);
}

/** Is BYO-key synthesis turned on in Settings? (A stored key is a separate, encrypted-IDB concern.) */
export function isSynthesisEnabled(): boolean {
	return read(SYNTHESIS_KEY);
}

export function setSynthesisEnabled(on: boolean): void {
	write(SYNTHESIS_KEY, on);
}
