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
});
