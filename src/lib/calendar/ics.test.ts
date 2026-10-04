import { describe, it, expect } from 'vitest';
import { serializeIcs } from './ics';

const NOW = new Date(Date.UTC(2026, 6, 11, 9, 30, 0)); // 2026-07-11T09:30:00Z

describe('serializeIcs', () => {
	it('wraps events in a METHOD-less VCALENDAR with VERSION + PRODID', () => {
		const out = serializeIcs([], NOW);
		expect(out.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
		expect(out).toContain('VERSION:2.0\r\n');
		expect(out).toContain('PRODID:');
		expect(out).not.toContain('METHOD:');
		expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true);
	});

	it('emits an all-day VALUE=DATE VEVENT with DTSTAMP, DTSTART, next-day DTEND, UID, SUMMARY', () => {
		const out = serializeIcs(
			[{ title: 'Attend TAP class', isoDate: '2026-08-14', uid: 'abc@mtc.local' }],
			NOW
		);
		expect(out).toContain('BEGIN:VEVENT\r\n');
		expect(out).toContain('UID:abc@mtc.local\r\n');
		expect(out).toContain('DTSTAMP:20260711T093000Z\r\n');
		expect(out).toContain('DTSTART;VALUE=DATE:20260814\r\n');
		expect(out).toContain('DTEND;VALUE=DATE:20260815\r\n');
		expect(out).toContain('SUMMARY:Attend TAP class\r\n');
		expect(out).toContain('END:VEVENT\r\n');
	});

	it('escapes TEXT special chars in SUMMARY (backslash, semicolon, comma, newline)', () => {
		const out = serializeIcs(
			[{ title: 'Enroll; submit A,B\\C\nnow', isoDate: '2026-08-14', uid: 'u@mtc.local' }],
			NOW
		);
		expect(out).toContain('SUMMARY:Enroll\\; submit A\\,B\\\\C\\nnow\r\n');
	});

	it('folds a content line longer than 75 octets with CRLF + space', () => {
		const long = 'x'.repeat(120);
		const out = serializeIcs([{ title: long, isoDate: '2026-08-14', uid: 'u@mtc.local' }], NOW);
		const summaryLine = out.split('\r\n').findIndex((l) => l.startsWith('SUMMARY:'));
		expect(out.split('\r\n')[summaryLine + 1]?.startsWith(' ')).toBe(true); // continuation is folded
	});

	it('adds one display alert per alarm day, at 09:00 the given number of days before', () => {
		const out = serializeIcs(
			[
				{
					title: 'Last day: File, now',
					isoDate: '2026-10-20',
					uid: 'u@mtc.local',
					alarmDays: [30, 7, 1]
				}
			],
			NOW
		);
		expect(out.match(/BEGIN:VALARM\r\n/g)?.length).toBe(3);
		expect(out).toContain('TRIGGER:-P29DT15H\r\n');
		expect(out).toContain('TRIGGER:-P6DT15H\r\n');
		expect(out).toContain('TRIGGER:-PT15H\r\n');
		expect(out).toContain('ACTION:DISPLAY\r\n');
		expect(out).toContain('DESCRIPTION:Last day: File\\, now\r\n');
		// Alerts belong to the event: every VALARM closes before the VEVENT does.
		expect(out.lastIndexOf('END:VALARM')).toBeLessThan(out.indexOf('END:VEVENT'));
	});

	// A re-add after a date change moves events the user already has, and an app that compares versions keeps the
	// higher one: every add carries a version that rises with time, with nothing stored anywhere.
	it('gives every event a version number that rises with each later add', () => {
		const event = { title: 'Last day: X', isoDate: '2026-10-20', uid: 'u@mtc.local' };
		const versions = (now: Date) =>
			[
				...serializeIcs([event, { ...event, uid: 'v@mtc.local' }], now).matchAll(
					/^SEQUENCE:(\d+)\r?$/gm
				)
			].map((m) => Number(m[1]));
		const first = versions(NOW);
		expect(first).toHaveLength(2);
		expect(first[0]).toBe(first[1]);
		expect(versions(new Date(NOW.getTime() + 60_000))[0]).toBeGreaterThan(first[0] ?? Infinity);
		// A device clock set far back still writes a valid, non-negative number.
		expect(versions(new Date(Date.UTC(2020, 0, 1)))).toEqual([0, 0]);
	});

	it('adds no alert when an event has none', () => {
		const out = serializeIcs(
			[{ title: 'Opens: X', isoDate: '2026-11-01', uid: 'u@mtc.local', alarmDays: [] }],
			NOW
		);
		expect(out).not.toContain('VALARM');
	});
});
