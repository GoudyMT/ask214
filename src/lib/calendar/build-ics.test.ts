import { afterEach, describe, it, expect, vi } from 'vitest';
import { buildIcs } from './build-ics';
import { computeIcsUid } from './uid';
import { generateTimeline, type TimelineItem } from '../timeline/generate';
import { TASK_DEFS } from '../timeline/task-defs';
import type { EaosString } from '../profile/eaos';

const NOW = new Date('2026-10-03T12:00:00Z');

describe('buildIcs', () => {
	it('keeps the per-task calendar ID on the "Last day" event and keys the other moments apart', async () => {
		const bdd: TimelineItem = {
			def: {
				id: 'bdd',
				title: 'BDD',
				category: 'benefits',
				finishBefore: 'separation',
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
		const ics = (await buildIcs([bdd], { taskIds: [], categories: [] }, NOW)).ics.replace(
			/\r\n /g,
			''
		);
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
				finishBefore: 'separation',
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
		const ics = (await buildIcs([soft], { taskIds: [], categories: [] }, NOW)).ics.replace(
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
				finishBefore: 'separation',
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
		const ics = (await buildIcs([vgli], { taskIds: [], categories: [] }, NOW)).ics.replace(
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
			finishBefore: 'separation',
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
			(await buildIcs([firm('today', '2026-10-03'), firm('soon', '2026-10-05')], none, evening)).ics
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
		const { ics } = await buildIcs(
			[firm('yesterday', '2026-10-03'), firm('today', '2026-10-04')],
			none,
			morning
		);
		expect(ics).not.toContain('DTSTART;VALUE=DATE:20261003');
		expect(ics).toContain('DTSTART;VALUE=DATE:20261004');
	});

	it('a "Before you leave" event keeps the task\'s own calendar ID', async () => {
		const it0: TimelineItem = {
			def: {
				id: 'sha-complete',
				title: 'Complete your SHA',
				category: 'medical',
				finishBefore: 'terminal-leave',
				kind: 'required',
				windowStart: -150,
				windowEnd: -90,
				why: ''
			},
			targetDate: '2026-11-14',
			windowStartDate: '2026-12-01',
			windowEndDate: '2026-11-14',
			status: 'after-you-leave'
		};
		const { ics } = await buildIcs(
			[it0],
			{ taskIds: [], categories: [] },
			new Date(2026, 9, 4, 12)
		);
		const unfolded = ics.replace(/\r\n /g, '');
		expect(unfolded).toContain(`UID:${await computeIcsUid('sha-complete')}`);
		expect(unfolded).toContain('SUMMARY:Before you leave: Complete your SHA');
	});

	it('the leaving dates change only event dates, alerts and the Before-you-leave prefix - nothing is added', async () => {
		const now = new Date(2026, 9, 4, 12);
		const fileFor = async (leaving?: object) => {
			const persona = {
				completeness: 'eaos-only' as const,
				eaos: '2027-04-30' as EaosString,
				daysUntilSeparation: 208,
				...(leaving ? { leaving: leaving as never } : {})
			};
			const items = generateTimeline(
				persona,
				[...TASK_DEFS],
				{ schemaVersion: 1, tasks: {} },
				now
			).phases.flatMap((p) => p.items);
			return (await buildIcs(items, { taskIds: [], categories: [] }, now)).ics.replace(
				/\r\n /g,
				''
			);
		};
		const withDates = await fileFor({
			skillbridgeStart: '2026-11-01',
			terminalLeaveStart: '2027-04-01'
		});
		const allowed = new Set([
			'BEGIN',
			'END',
			'UID',
			'DTSTAMP',
			'SEQUENCE',
			'DTSTART',
			'DTEND',
			'SUMMARY',
			'ACTION',
			'DESCRIPTION',
			'TRIGGER',
			'VERSION',
			'PRODID',
			'CALSCALE'
		]);
		for (const line of withDates.split('\r\n').filter(Boolean)) {
			expect(allowed.has(line.split(/[;:]/)[0] ?? '')).toBe(true);
		}
		expect(withDates).not.toMatch(/SkillBridge|terminal leave/i);
		// SUMMARY text is escaped in the file (a comma is written "\,"); undo that to compare with the task titles.
		const titles = (ics: string) =>
			[...ics.matchAll(/SUMMARY:(.*)/g)].map((m) =>
				(m[1] ?? '').replace(/\\([,;\\])/g, '$1').replace(/^Before you leave: /, '')
			);
		const without = await fileFor();
		// Every title in the dated file is a task title the undated file could also carry; no new kind of text.
		const known = new Set(TASK_DEFS.map((t) => t.title));
		for (const t of titles(withDates)) {
			expect(known.has(t.replace(/^(Opens|Changes|Last day|Aim for): /, '')), t).toBe(true);
		}
		expect(titles(without).length).toBeGreaterThan(0);
	});

	it('returns the events it wrote with the text', async () => {
		const file = await buildIcs(
			[
				{
					def: {
						id: 'a',
						title: 'A',
						category: 'admin',
						finishBefore: 'separation',
						kind: 'soft',
						windowStart: -180,
						windowEnd: -90,
						why: ''
					},
					targetDate: '2099-01-01',
					windowStartDate: '2098-12-01',
					windowEndDate: '2099-02-01',
					status: 'upcoming',
					aimDate: '2099-01-01'
				}
			],
			{ taskIds: [], categories: [] },
			new Date(2026, 9, 4, 12)
		);
		expect(file.events.map((e) => e.title)).toEqual(['Aim for: A']);
		expect(file.ics).toContain('SUMMARY:Aim for: A');
	});
});
