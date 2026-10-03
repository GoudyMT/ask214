import { describe, it, expect } from 'vitest';
import { calendarFileName, deviceKind, DEVICE_HINT } from './delivery';

describe('calendarFileName', () => {
	it('names the file by the day of the add, so a later add never meets "file already exists"', () => {
		expect(calendarFileName(new Date('2026-10-03T08:00:00Z'))).toBe(
			'ask214-deadlines-2026-10-03.ics'
		);
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
