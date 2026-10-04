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
		// An app that matches events by ID can then update the one a user already has instead of duplicating it.
		expect(ics).toContain(`UID:${await computeIcsUid('bdd')}\r\n`);
		expect(ics).toContain(`UID:${await computeIcsUid('bdd:opens')}\r\n`);
	});

	it('keeps the per-task calendar ID on a soft task\'s "Aim for" event', async () => {
		const soft: TimelineItem = {
			def: {
				id: 's',
				title: 'S',
				category: 'admin',
				track: 'transition',
				kind: 'soft',
				windowStart: -180,
				windowEnd: -90,
				why: ''
			},
			targetDate: '2026-11-01',
			windowStartDate: '2026-11-01',
			windowEndDate: '2027-02-01',
			status: 'upcoming',
			aimDate: '2026-11-01'
		};
		const ics = (await buildIcs([soft], { taskIds: [], categories: [] }, NOW)).replace(
			/\r\n /g,
			''
		);
		expect(ics).toContain(`UID:${await computeIcsUid('s')}\r\n`);
		expect(ics).not.toContain(`UID:${await computeIcsUid('s:aim')}\r\n`);
	});

	it('gives each moment of a two-edge task its own calendar ID', async () => {
		const vgli: TimelineItem = {
			def: {
				id: 'v',
				title: 'V',
				category: 'benefits',
				track: 'transition',
				kind: 'closes',
				windowStart: 0,
				windowEnd: 240,
				finalEnd: 485,
				why: '',
				afterNote: 'n',
				changeNote: 'c'
			},
			targetDate: '2026-11-01',
			windowStartDate: '2026-11-01',
			windowEndDate: '2027-07-01',
			finalEndDate: '2028-03-01',
			status: 'upcoming'
		};
		const ics = (await buildIcs([vgli], { taskIds: [], categories: [] }, NOW)).replace(
			/\r\n /g,
			''
		);
		const uids = ics.split('\r\n').filter((line) => line.startsWith('UID:'));
		expect(uids).toHaveLength(3);
		expect(new Set(uids).size).toBe(3);
		expect(uids).toContain(`UID:${await computeIcsUid('v')}`);
		expect(uids).toContain(`UID:${await computeIcsUid('v:changes')}`);
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
