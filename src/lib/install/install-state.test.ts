import { describe, it, expect } from 'vitest';
import { isInstalled, isIOS, type StandaloneDeps, type IOSDeps } from './install-state';

function deps(over: Partial<StandaloneDeps> = {}): StandaloneDeps {
	return { displayModeStandalone: () => false, iosStandalone: () => false, ...over };
}

function iosDeps(over: Partial<IOSDeps> = {}): IOSDeps {
	return { userAgent: () => '', maxTouchPoints: () => 0, ...over };
}

describe('isInstalled', () => {
	it('is false for a normal browser tab', () => {
		expect(isInstalled(deps())).toBe(false);
	});

	it('is true when display-mode is standalone (installed PWA on most platforms)', () => {
		expect(isInstalled(deps({ displayModeStandalone: () => true }))).toBe(true);
	});

	it('is true when navigator.standalone is set (installed on iOS Safari)', () => {
		// iOS Safari does not report display-mode: standalone; it exposes the non-standard
		// navigator.standalone instead, so the check must cover both signals.
		expect(isInstalled(deps({ iosStandalone: () => true }))).toBe(true);
	});
});

describe('isIOS', () => {
	it('is true for an iPhone', () => {
		const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari';
		expect(isIOS(iosDeps({ userAgent: () => ua }))).toBe(true);
	});

	it('is true for iPadOS masquerading as a Mac (Macintosh UA + touch points)', () => {
		// iPadOS 13+ reports a Macintosh user agent; the touch-point count distinguishes it from a Mac.
		const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari';
		expect(isIOS(iosDeps({ userAgent: () => ua, maxTouchPoints: () => 5 }))).toBe(true);
	});

	it('is false for Android', () => {
		expect(isIOS(iosDeps({ userAgent: () => 'Mozilla/5.0 (Linux; Android 14) Chrome' }))).toBe(
			false
		);
	});

	it('is false for a real desktop Mac (Macintosh UA, no touch)', () => {
		const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari';
		expect(isIOS(iosDeps({ userAgent: () => ua, maxTouchPoints: () => 0 }))).toBe(false);
	});
});
