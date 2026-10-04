import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildIcs } from './build-ics';
import { computeIcsUid } from './uid';
import type { TimelineItem } from '../timeline/generate';

const NOW = new Date('2026-10-03T12:00:00Z');

describe('buildIcs', () => {
	it('keeps the per-task calendar ID on the "Last day" event and keys the other moments apart', async () => {
		const bdd: TimelineItem = {
			def: {
				id: 'bdd',
				title: 'BDD',
				category: 'benefits',
				track: 'transition',
				kind: 'closes',
				windowStart: -180,
				windowEnd: -90,
				why: '',
				afterNote: 'n'
			},
			targetDate: '2026-11-01',
			windowStartDate: '2026-11-01',
			windowEndDate: '2027-02-01',
			status: 'upcoming'
		};
		// A UID line is 78 octets, so it always folds: join the folds before reading.
		const ics = (await buildIcs([bdd], { taskIds: [], categories: [] }, NOW)).replace(/\r\n /g, '');
		// A re-add then updates the event a user already has instead of duplicating it.
		expect(ics).toContain(`UID:${await computeIcsUid('bdd')}\r\n`);
		expect(ics).toContain(`UID:${await computeIcsUid('bdd:opens')}\r\n`);
	});
});

// The file's today is the date on the user's clock: on a New York evening the UTC date is already tomorrow, and on
// a Tokyo morning it is still yesterday.
describe('buildIcs on the device clock', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	const firm = (id: string, lastDay: string): TimelineItem => ({
		def: {
			id,
			title: id,
			category: 'benefits',
			track: 'transition',
			kind: 'closes',
			windowStart: -180,
			windowEnd: -90,
			why: '',
			afterNote: 'n'
		},
		targetDate: '2026-08-01',
		windowStartDate: '2026-08-01',
		windowEndDate: lastDay,
		status: 'closing-soon'
	});
	const none = { taskIds: [], categories: [] };
	const unfold = (ics: string) => ics.replace(/\r\n /g, '');

	it("keeps today's last day and tomorrow morning's alert on a New York evening", async () => {
		vi.stubEnv('TZ', 'America/New_York');
		const evening = new Date('2026-10-04T01:00:00Z');
		expect(evening.getHours()).toBe(21); // the zone took effect: 21:00 on Oct 3
		const ics = unfold(
			await buildIcs([firm('today', '2026-10-03'), firm('soon', '2026-10-05')], none, evening)
		);
		expect(ics).toContain(
			'DTSTART;VALUE=DATE:20261003\r\nDTEND;VALUE=DATE:20261004\r\nSUMMARY:Last day: today'
		);
		// The 1-day alert before Oct 5 fires at 09:00 on Oct 4, still ahead.
		expect(ics).toContain('TRIGGER:-PT15H');
	});

	it('leaves out a last day that has passed on a Tokyo morning', async () => {
		vi.stubEnv('TZ', 'Asia/Tokyo');
		const morning = new Date('2026-10-03T23:30:00Z');
		expect(morning.getHours()).toBe(8); // the zone took effect: 08:30 on Oct 4
		const ics = await buildIcs(
			[firm('yesterday', '2026-10-03'), firm('today', '2026-10-04')],
			none,
			morning
		);
		expect(ics).not.toContain('DTSTART;VALUE=DATE:20261003');
		expect(ics).toContain('DTSTART;VALUE=DATE:20261004');
	});
});
