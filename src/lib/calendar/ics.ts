import { addDays } from '../timeline/day-math';

const PRODID = '-//Ask 214//Calendar//EN';
/** 2000-01-01T00:00:00Z in whole seconds: the event version counts from here. */
const VERSION_EPOCH_SECONDS = 946_684_800;

/** Escape an iCalendar TEXT value (RFC 5545 3.3.11): backslash, semicolon, comma, newline. */
function escapeText(s: string): string {
	return s
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line to <= 75 OCTETS (RFC 5545 3.1); continuation = CRLF + single space. Folds
 *  on UTF-8 lead-byte boundaries so a multibyte sequence is never split. */
function foldLine(line: string): string {
	const bytes = new TextEncoder().encode(line);
	if (bytes.length <= 75) return line;
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	let start = 0;
	let limit = 75; // first line 75; continuations 74 (+ the leading space = 75)
	while (start < bytes.length) {
		let end = Math.min(start + limit, bytes.length);
		while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
		chunks.push(decoder.decode(bytes.subarray(start, end)));
		start = end;
		limit = 74;
	}
	return chunks.join('\r\n ');
}

/** UTC Date -> iCalendar UTC DATE-TIME YYYYMMDDTHHMMSSZ (for DTSTAMP): the ISO form without its separators and
 *  milliseconds. */
function formatDtstamp(now: Date): string {
	return now.toISOString().replace(/[-:]|\.\d+/g, '');
}

/** ISO YYYY-MM-DD -> DATE YYYYMMDD. */
function toDateValue(iso: string): string {
	return iso.replace(/-/g, '');
}

/** The day AFTER an ISO date, as DATE YYYYMMDD (non-inclusive all-day DTEND). */
function nextDateValue(iso: string): string {
	return toDateValue(addDays(iso, 1));
}

/** An alert `days` before an all-day event, at 09:00: the event starts at local midnight. */
function alarmTrigger(days: number): string {
	return days === 1 ? '-PT15H' : `-P${days - 1}DT15H`;
}

/**
 * Serialize desired events to a one-way iCalendar file (RFC 5545 core; NO METHOD, so no iTIP
 * ORGANIZER/email is required). All-day VALUE=DATE events (timezone-independent). Each event
 * carries a stable UID and a rising SEQUENCE, so an app that honors them updates on a re-import
 * rather than duplicating. CRLF endings, 75-octet
 * folding, TEXT-escaped SUMMARY, and a display VALARM per alarm day. `now` is injected for a
 * deterministic DTSTAMP.
 */
export function serializeIcs(
	events: { title: string; isoDate: string; uid: string; alarmDays?: readonly number[] }[],
	now: Date
): string {
	const dtstamp = formatDtstamp(now);
	// The event's version (RFC 5545 3.8.7.4): whole seconds since 2000 at the add, so each later add carries a
	// higher one and an app that compares versions updates the event instead of keeping the old one. Counting from
	// 2000 keeps it inside the format's 32-bit integer until 2068.
	const sequence = Math.floor(now.getTime() / 1000) - VERSION_EPOCH_SECONDS;
	const lines: string[] = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		`PRODID:${PRODID}`,
		'CALSCALE:GREGORIAN'
	];
	for (const ev of events) {
		lines.push(
			'BEGIN:VEVENT',
			foldLine(`UID:${ev.uid}`),
			`DTSTAMP:${dtstamp}`,
			`SEQUENCE:${sequence}`,
			`DTSTART;VALUE=DATE:${toDateValue(ev.isoDate)}`,
			`DTEND;VALUE=DATE:${nextDateValue(ev.isoDate)}`,
			foldLine(`SUMMARY:${escapeText(ev.title)}`)
		);
		for (const days of ev.alarmDays ?? []) {
			lines.push(
				'BEGIN:VALARM',
				'ACTION:DISPLAY',
				foldLine(`DESCRIPTION:${escapeText(ev.title)}`),
				`TRIGGER:${alarmTrigger(days)}`,
				'END:VALARM'
			);
		}
		lines.push('END:VEVENT');
	}
	lines.push('END:VCALENDAR');
	return lines.join('\r\n') + '\r\n';
}
