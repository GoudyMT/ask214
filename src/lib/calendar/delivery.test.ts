import { afterEach, describe, it, expect, vi } from 'vitest';
import { calendarFileName, deviceKind, deviceHint, DEVICE_HINT, IOS_APP_HINT } from './delivery';

describe('calendarFileName', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('names the file by the day of the add, so a later add never meets "file already exists"', () => {
		expect(calendarFileName(new Date('2026-10-03T12:00:00Z'))).toBe(
			'ask214-deadlines-2026-10-03.ics'
		);
	});

	it('dates the file by the local day on a US evening', () => {
		vi.stubEnv('TZ', 'America/Los_Angeles');
		const evening = new Date('2026-10-04T01:00:00Z');
		expect(evening.getHours()).toBe(18); // the zone took effect: 18:00 on Oct 3
		expect(calendarFileName(evening)).toBe('ask214-deadlines-2026-10-03.ics');
	});
});

describe('deviceKind', () => {
	it('reads Android, iPhone and iPad, and treats everything else as a computer', () => {
		expect(
			deviceKind(
				'Mozilla/5.0 (Linux; Android 16; SM-S941U) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36',
				5
			)
		).toBe('android');
		expect(
			deviceKind(
				'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1',
				5
			)
		).toBe('ios');
		// iPadOS asks for desktop pages with a Mac user agent; touch points give it away.
		expect(
			deviceKind(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.5 Safari/605.1.15',
				5
			)
		).toBe('ios');
		expect(
			deviceKind(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.5 Safari/605.1.15',
				0
			)
		).toBe('computer');
		expect(
			deviceKind(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36',
				0
			)
		).toBe('computer');
	});

	it('has one sentence per device', () => {
		expect(Object.keys(DEVICE_HINT).sort()).toEqual(['android', 'computer', 'ios']);
	});
});

// The installed iPhone app keeps its data apart from Safari, so it must never be told to go to Safari.
describe('deviceHint', () => {
	it('sends an iPhone browser to Safari, and the installed iPhone app only to its downloads', () => {
		expect(deviceHint('ios', false)).toEqual(DEVICE_HINT.ios);
		expect(deviceHint('ios', true)).toEqual(IOS_APP_HINT);
		expect(`${IOS_APP_HINT.lead} ${IOS_APP_HINT.text}`).not.toContain('Safari');
		expect(IOS_APP_HINT.text).toContain('Open it from Downloads');
	});

	it('keeps the same sentence for an installed app on Android or a computer', () => {
		expect(deviceHint('android', true)).toEqual(DEVICE_HINT.android);
		expect(deviceHint('computer', true)).toEqual(DEVICE_HINT.computer);
	});
});
