const PRODID = '-//Ask 214//Calendar//EN';

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

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

/** UTC Date -> iCalendar UTC DATE-TIME YYYYMMDDTHHMMSSZ (for DTSTAMP). */
function formatDtstamp(now: Date): string {
	return (
		`${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
		`T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`
	);
}

/** ISO YYYY-MM-DD -> DATE YYYYMMDD. */
function toDateValue(iso: string): string {
	return iso.replace(/-/g, '');
}

/** The day AFTER an ISO date, as DATE YYYYMMDD (non-inclusive all-day DTEND). */
function nextDateValue(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y!, m! - 1, d! + 1));
	return `${dt.getUTCFullYear()}${pad2(dt.getUTCMonth() + 1)}${pad2(dt.getUTCDate())}`;
}

/**
 * Serialize desired events to a one-way iCalendar file (RFC 5545 core; NO METHOD, so no iTIP
 * ORGANIZER/email is required). All-day VALUE=DATE events (timezone-independent). Each event
 * carries a stable UID so a re-import updates rather than duplicates. CRLF endings, 75-octet
 * folding, TEXT-escaped SUMMARY. `now` is injected for a deterministic DTSTAMP.
 */
export function serializeIcs(
	events: { title: string; isoDate: string; uid: string }[],
	now: Date
): string {
	const dtstamp = formatDtstamp(now);
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
			`DTSTART;VALUE=DATE:${toDateValue(ev.isoDate)}`,
			`DTEND;VALUE=DATE:${nextDateValue(ev.isoDate)}`,
			foldLine(`SUMMARY:${escapeText(ev.title)}`),
			'END:VEVENT'
		);
	}
	lines.push('END:VCALENDAR');
	return lines.join('\r\n') + '\r\n';
}
