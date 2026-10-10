import { afterEach, describe, it, expect, vi } from 'vitest';
import {
	filterAndAnchor,
	deriveStatus,
	generateTimeline,
	todayMarkerIndex,
	type AnchoredTask
} from './generate';
import { selectNeedsNow } from './needs-now';
import { TASK_DEFS } from './task-defs';
import { SKILLBRIDGE_PLAN_KEY } from './skillbridge-plan';
import { eaosOffsetDate, daysUntilSeparation, type EaosString } from '../profile/eaos';
import { addDays, daysBetween, localTodayIso } from './day-math';
import type { PersonaFilters } from '../profile/persona';
import type { TaskDef, TimelineTaskState, TimelineState } from './types';

const EAOS = '2027-04-15' as EaosString;

const universal: TaskDef = {
	id: 'u1',
	title: 'Universal task',
	category: 'admin',
	finishBefore: 'separation',
	kind: 'soft',
	windowStart: -180,
	windowEnd: -90,
	recommendedOffset: -120,
	why: 'w'
};

const noRecommended: TaskDef = {
	id: 'n1',
	title: 'No recommended offset',
	category: 'admin',
	finishBefore: 'separation',
	kind: 'soft',
	windowStart: -60,
	windowEnd: -30,
	why: 'w'
};

const gatedSchool: TaskDef = {
	id: 'g1',
	title: 'School-only task',
	category: 'career',
	finishBefore: 'separation',
	kind: 'soft',
	windowStart: -365,
	windowEnd: -180,
	why: 'w',
	requires: { intendedPath: ['school'] }
};

const eaosOnly: PersonaFilters = {
	completeness: 'eaos-only',
	eaos: EAOS,
	daysUntilSeparation: 100
};

const completeSchool: PersonaFilters = {
	completeness: 'complete',
	eaos: EAOS,
	daysUntilSeparation: 100,
	rate: 'IT',
	rank: 'E5',
	familyStatus: 'single',
	intendedPath: 'school'
};

const completeWork: PersonaFilters = { ...completeSchool, intendedPath: 'employment' };

describe('filterAndAnchor (gate + anchor)', () => {
	it('includes universal tasks for any persona with an EAOS', () => {
		const ids = filterAndAnchor(eaosOnly, [universal, gatedSchool]).map((i) => i.def.id);
		expect(ids).toContain('u1');
	});

	it('hides a gated task when the persona field is unset (hide-when-unset)', () => {
		const ids = filterAndAnchor(eaosOnly, [universal, gatedSchool]).map((i) => i.def.id);
		expect(ids).not.toContain('g1');
	});

	it('includes a gated task only when the persona value is in the gate list', () => {
		const match = filterAndAnchor(completeSchool, [gatedSchool]).map((i) => i.def.id);
		const noMatch = filterAndAnchor(completeWork, [gatedSchool]).map((i) => i.def.id);
		expect(match).toContain('g1');
		expect(noMatch).not.toContain('g1');
	});

	it('anchors targetDate + window dates to EAOS + offsets (recommendedOffset wins)', () => {
		const [item] = filterAndAnchor(eaosOnly, [universal]);
		expect(item?.targetDate).toBe(eaosOffsetDate(EAOS, -120));
		expect(item?.windowStartDate).toBe(eaosOffsetDate(EAOS, -180));
		expect(item?.windowEndDate).toBe(eaosOffsetDate(EAOS, -90));
	});

	it('falls back to windowStart for targetDate when recommendedOffset is absent', () => {
		const [item] = filterAndAnchor(eaosOnly, [noRecommended]);
		expect(item?.targetDate).toBe(eaosOffsetDate(EAOS, -60));
	});

	it('returns an empty list for a none persona (no EAOS to anchor against)', () => {
		expect(filterAndAnchor({ completeness: 'none' }, [universal])).toEqual([]);
	});
});

describe('deriveStatus (status + snooze-expiry)', () => {
	const anchored: AnchoredTask = {
		def: universal,
		sortOffset: -120,
		targetDate: '2027-01-15',
		windowStartDate: '2027-01-01',
		windowEndDate: '2027-03-01',
		separationDate: '2027-05-30'
	};
	const inWindow = new Date('2027-02-01T12:00:00Z');

	it('derives "upcoming" before the window opens', () => {
		expect(deriveStatus(anchored, undefined, new Date('2026-12-01T12:00:00Z'))).toBe('upcoming');
	});

	it('derives "start-now" inside the window', () => {
		expect(deriveStatus(anchored, undefined, inWindow)).toBe('start-now');
	});

	it('derives "still-to-do" after a soft window ends', () => {
		expect(deriveStatus(anchored, undefined, new Date('2027-04-01T12:00:00Z'))).toBe('still-to-do');
	});

	it('lets stored "done" win regardless of the date', () => {
		const stored: TimelineTaskState = { status: 'done' };
		expect(deriveStatus(anchored, stored, inWindow)).toBe('done');
	});

	it('lets stored "skipped" win regardless of the date', () => {
		const stored: TimelineTaskState = { status: 'skipped' };
		expect(deriveStatus(anchored, stored, inWindow)).toBe('skipped');
	});

	it('stays "snoozed" while snoozeUntil is in the future', () => {
		const stored: TimelineTaskState = { status: 'snoozed', snoozeUntil: '2027-12-31' };
		expect(deriveStatus(anchored, stored, inWindow)).toBe('snoozed');
	});

	it('auto-reopens to the date-derived status when snoozeUntil has passed', () => {
		const stored: TimelineTaskState = { status: 'snoozed', snoozeUntil: '2027-01-15' };
		expect(deriveStatus(anchored, stored, inWindow)).toBe('start-now');
	});
});

describe('generateTimeline (sort + group + assemble)', () => {
	const mk = (id: string, recommendedOffset: number): TaskDef => ({
		id,
		title: id,
		category: 'admin',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: recommendedOffset,
		windowEnd: recommendedOffset + 30,
		recommendedOffset,
		why: 'w'
	});
	const emptyState: TimelineState = { schemaVersion: 1, tasks: {} };
	const persona: PersonaFilters = {
		completeness: 'eaos-only',
		eaos: EAOS,
		daysUntilSeparation: 100
	};
	const today = new Date('2026-06-04T12:00:00Z');

	it('groups tasks into their phase buckets and drops empty buckets', () => {
		// -600 -> 24-18mo, -120 -> 6-3mo, 30 -> after; 18-12mo/12-6mo/final90 stay empty.
		const defs = [mk('a', -600), mk('b', -120), mk('c', 30)];
		const view = generateTimeline(persona, defs, emptyState, today);
		expect(view.phases.map((p) => p.bucket.id)).toEqual(['24-18mo', '6-3mo', 'after']);
	});

	it('sorts furthest-out first across and within buckets', () => {
		const defs = [mk('c', 30), mk('a', -600), mk('b', -120)];
		const view = generateTimeline(persona, defs, emptyState, today);
		const ids = view.phases.flatMap((p) => p.items.map((i) => i.def.id));
		expect(ids).toEqual(['a', 'b', 'c']);
	});

	it('exposes per-bucket counts and a total', () => {
		// -600 and -560 both fall in 24-18mo [-730,-540); -120 in 6-3mo.
		const defs = [mk('a', -600), mk('a2', -560), mk('b', -120)];
		const view = generateTimeline(persona, defs, emptyState, today);
		expect(view.phases[0]?.bucket.id).toBe('24-18mo');
		expect(view.phases[0]?.count).toBe(2);
		expect(view.total).toBe(3);
	});

	it('attaches the derived status to each item', () => {
		const state: TimelineState = { schemaVersion: 1, tasks: { b: { status: 'done' } } };
		const view = generateTimeline(persona, [mk('b', -120)], state, today);
		expect(view.phases[0]?.items[0]?.status).toBe('done');
	});

	it('surfaces snoozeUntil on a snoozed item (decision A: snoozed shows the date)', () => {
		const state: TimelineState = {
			schemaVersion: 1,
			tasks: { b: { status: 'snoozed', snoozeUntil: '2026-12-31' } }
		};
		const item = generateTimeline(persona, [mk('b', -120)], state, today).phases[0]?.items[0];
		expect(item?.status).toBe('snoozed');
		expect(item?.snoozeUntil).toBe('2026-12-31');
	});

	it('omits snoozeUntil when the item is not snoozed (no stale date leaks through done)', () => {
		const state: TimelineState = {
			schemaVersion: 1,
			tasks: { b: { status: 'done', snoozeUntil: '2026-12-31' } }
		};
		const item = generateTimeline(persona, [mk('b', -120)], state, today).phases[0]?.items[0];
		expect(item?.status).toBe('done');
		expect(item?.snoozeUntil).toBeUndefined();
	});

	it('returns an empty view for a none persona (route renders the setup CTA)', () => {
		const view = generateTimeline({ completeness: 'none' }, [mk('a', -600)], emptyState, today);
		expect(view.phases).toEqual([]);
		expect(view.total).toBe(0);
	});

	it('marks a phase collapsible when every task is done or skipped, with counts', () => {
		const defs = [mk('a', -600), mk('a2', -560)]; // both in 24-18mo
		const state: TimelineState = {
			schemaVersion: 1,
			tasks: { a: { status: 'done' }, a2: { status: 'skipped' } }
		};
		const phase = generateTimeline(persona, defs, state, today).phases[0];
		expect(phase?.collapsible).toBe(true);
		expect(phase?.counts).toEqual({ done: 1, skipped: 1, snoozed: 0, toDo: 0, closed: 0 });
	});

	// A closed task can no longer be done, so it is counted apart from "to do". Its card stays reachable for 14 days,
	// because "Needs you now" lists it under "Just closed" and those rows jump to the card, which a folded phase hides.
	describe('a closed task in a phase', () => {
		const closedDaysAgo = (days: number) => {
			const closedOn = addDays(localTodayIso(today), -days);
			const firm = (id: string): TaskDef => ({
				...mk(id, daysBetween(EAOS, closedOn) - 30),
				kind: 'closes',
				windowEnd: daysBetween(EAOS, closedOn),
				afterNote: 'n'
			});
			const state: TimelineState = { schemaVersion: 1, tasks: { a: { status: 'done' } } };
			const phases = generateTimeline(persona, [firm('a'), firm('c')], state, today).phases;
			expect(phases.length).toBe(1);
			return phases[0];
		};

		it('is counted as closed, not to do, and the phase folds once it closed more than 14 days ago', () => {
			const phase = closedDaysAgo(15);
			expect(phase?.items.map((i) => i.status)).toEqual(['done', 'closed']);
			expect(phase?.counts).toEqual({ done: 1, skipped: 0, snoozed: 0, toDo: 0, closed: 1 });
			expect(phase?.collapsible).toBe(true);
		});

		it('keeps the phase open while it closed 14 days ago or less', () => {
			const phase = closedDaysAgo(14);
			expect(phase?.counts).toEqual({ done: 1, skipped: 0, snoozed: 0, toDo: 0, closed: 1 });
			expect(phase?.collapsible).toBe(false);
		});
	});

	it('keeps a phase non-collapsible when an active task remains, counting toDo', () => {
		const defs = [mk('a', -600), mk('a2', -560)];
		const state: TimelineState = { schemaVersion: 1, tasks: { a: { status: 'done' } } };
		const phase = generateTimeline(persona, defs, state, today).phases[0];
		expect(phase?.collapsible).toBe(false);
		expect(phase?.counts?.done).toBe(1);
		expect(phase?.counts?.toDo).toBe(1); // a2 derives active (still to do) -> still "to do"
	});

	it('keeps a phase non-collapsible when a task is snoozed (paused, not resolved)', () => {
		const defs = [mk('a', -600), mk('a2', -560)];
		const state: TimelineState = {
			schemaVersion: 1,
			tasks: { a: { status: 'done' }, a2: { status: 'snoozed', snoozeUntil: '2026-12-31' } }
		};
		const phase = generateTimeline(persona, defs, state, today).phases[0];
		expect(phase?.collapsible).toBe(false);
		expect(phase?.counts?.snoozed).toBe(1);
		expect(phase?.counts?.toDo).toBe(0);
	});

	it('surfaces a stored note on the timeline item (any status)', () => {
		const state: TimelineState = {
			schemaVersion: 1,
			tasks: { b: { notes: 'Reached out to 3 hosts.' } }
		};
		const item = generateTimeline(persona, [mk('b', -120)], state, today).phases[0]?.items[0];
		expect(item?.note).toBe('Reached out to 3 hosts.');
	});

	it('omits note when none is stored', () => {
		const item = generateTimeline(persona, [mk('b', -120)], emptyState, today).phases[0]?.items[0];
		expect(item?.note).toBeUndefined();
	});
});

describe('Fit: the leaving dates pull in a last day, never an opening', () => {
	const SEP = '2027-04-30' as EaosString;
	const TODAY = new Date(2026, 9, 4, 12); // Oct 4, 2026, local
	const leaving = (l: {
		skillbridgeStart?: string;
		terminalLeaveStart?: string;
	}): PersonaFilters => ({
		completeness: 'eaos-only',
		eaos: SEP,
		daysUntilSeparation: 208,
		leaving: l as never
	});
	const item = (p: PersonaFilters, id: string) => {
		const view = generateTimeline(p, [...TASK_DEFS], { schemaVersion: 1, tasks: {} }, TODAY);
		const found = view.phases.flatMap((ph) => ph.items).find((i) => i.def.id === id);
		if (!found) throw new Error('E_TEST_TASK_MISSING');
		return found;
	};

	it('a leaving task ends the day before SkillBridge starts', () => {
		const capstone = item(leaving({ skillbridgeStart: '2026-11-01' }), 'tap-capstone');
		expect(capstone.windowStartDate).toBe('2026-04-30'); // the opening never moves
		expect(capstone.windowEndDate).toBe('2026-10-31');
		expect(capstone.status).toBe('closing-soon');
		expect(capstone.daysLeft).toBe(27); // the countdown runs to the pulled-in last day: Oct 4 -> Oct 31
		expect(capstone.fit).toEqual({ reason: 'skillbridge', date: '2026-10-31' });
	});

	it('a required task past its pulled-in last day stays late until the real separation', () => {
		const capstone = item(leaving({ skillbridgeStart: '2026-09-01' }), 'tap-capstone');
		expect(capstone.windowEndDate).toBe('2026-08-31');
		expect(capstone.status).toBe('late');
	});

	it('a window already ending before the leaving day is untouched', () => {
		const presep = item(leaving({ skillbridgeStart: '2026-11-01' }), 'preseparation-counseling');
		expect(presep.windowEndDate).toBe('2026-04-30');
		expect(presep.fit).toBeUndefined();
	});

	it('a terminal-leave task ignores SkillBridge and fits before terminal leave', () => {
		expect(item(leaving({ skillbridgeStart: '2026-11-01' }), 'sha-complete').windowEndDate).toBe(
			'2027-01-30'
		);
		const sha = item(leaving({ terminalLeaveStart: '2026-11-15' }), 'sha-complete');
		expect(sha.status).toBe('after-you-leave'); // opens Dec 1, after the Nov 14 last day
		expect(sha.windowStartDate).toBe('2026-12-01');
		expect(sha.windowEndDate).toBe('2026-11-14');
	});

	it('the earlier date anchors a leaving task, and names the reason', () => {
		const both = item(
			leaving({ skillbridgeStart: '2027-04-05', terminalLeaveStart: '2027-04-01' }),
			'tap-capstone'
		);
		expect(both.windowEndDate).toBe('2027-01-30'); // official end is already earlier
		const early = item(
			leaving({ skillbridgeStart: '2027-01-20', terminalLeaveStart: '2027-01-10' }),
			'tap-capstone'
		);
		expect(early.windowEndDate).toBe('2027-01-09');
		expect(early.fit?.reason).toBe('terminal-leave');
		// The reason names the last day, not the target, which stays at its own earlier date (Dec 31).
		expect(early.fit).toEqual({ reason: 'terminal-leave', date: '2027-01-09' });
	});

	it('a leaving date the day after the official last day moves nothing', () => {
		const capstone = item(leaving({ skillbridgeStart: '2027-01-31' }), 'tap-capstone');
		expect(capstone.windowEndDate).toBe('2027-01-30');
		expect(capstone.fit).toBeUndefined();
	});

	it('a task opening on the first day away cannot fit; one day earlier it can', () => {
		const letters = item(leaving({ skillbridgeStart: '2026-11-01' }), 'reference-letters');
		expect(letters.status).toBe('after-you-leave');
		expect(letters.fit).toBeUndefined(); // no reason on a date: the card shows the opening instead
		const oneDay = item(leaving({ skillbridgeStart: '2026-11-02' }), 'reference-letters');
		expect(oneDay.windowStartDate).toBe('2026-11-01');
		expect(oneDay.windowEndDate).toBe('2026-11-01');
		expect(oneDay.status).toBe('upcoming');
	});

	it('a soft aim date is held inside the shortened window', () => {
		const track = item(leaving({ skillbridgeStart: '2026-11-01' }), 'tap-track');
		expect(track.aimDate).toBe('2026-10-31');
	});

	it('a separation task never moves', () => {
		const bdd = item(leaving({ skillbridgeStart: '2026-11-01' }), 'va-bdd-claim');
		expect(bdd.windowEndDate).toBe('2027-01-30');
		expect(bdd.fit).toBeUndefined();
	});

	it('a pulled-in task sorts by its fitted date', () => {
		const view = generateTimeline(
			leaving({ skillbridgeStart: '2026-11-01' }),
			[...TASK_DEFS],
			{ schemaVersion: 1, tasks: {} },
			TODAY
		);
		const capstonePhase = view.phases.find((ph) =>
			ph.items.some((i) => i.def.id === 'tap-capstone')
		);
		// Oct 31 is 181 days out: the 12-6 months phase ([-365, -180)); without SkillBridge it sits in 6-3 months.
		expect(capstonePhase?.bucket.id).toBe('12-6mo');
	});

	it('the separation package counts its whole window from the day you leave', () => {
		const pkg = item(leaving({ skillbridgeStart: '2026-11-01' }), 'separation-package');
		expect(pkg.windowStartDate).toBe('2026-02-04'); // 270 days before Nov 1
		expect(pkg.targetDate).toBe('2026-06-04'); // 150 days before
		expect(pkg.windowEndDate).toBe('2026-07-04'); // 120 days before
		expect(pkg.fit).toBeUndefined(); // moved whole, never shortened
		expect(pkg.status).toBe('late');
	});

	it('the separation package counts from SkillBridge when terminal leave follows it', () => {
		const pkg = item(
			leaving({ skillbridgeStart: '2026-11-01', terminalLeaveStart: '2027-03-01' }),
			'separation-package'
		);
		expect(pkg.windowEndDate).toBe('2026-07-04');
	});

	it('the separation package counts from terminal leave when it is the only date', () => {
		const pkg = item(leaving({ terminalLeaveStart: '2027-03-01' }), 'separation-package');
		expect(pkg.windowStartDate).toBe('2026-06-04');
		expect(pkg.windowEndDate).toBe('2026-11-01');
		expect(pkg.status).toBe('closing-soon'); // 28 days left
	});

	it('with no leaving date the separation package closes 120 days before separation', () => {
		const pkg = item(leaving({}), 'separation-package');
		expect(pkg.windowStartDate).toBe('2026-08-03');
		expect(pkg.targetDate).toBe('2026-12-01');
		expect(pkg.windowEndDate).toBe('2026-12-31');
		expect(pkg.status).toBe('start-now');
	});

	it('the DD-214 review counts from the day you leave and ends 15 days before it', () => {
		const review = item(leaving({ skillbridgeStart: '2026-11-01' }), 'dd214-review');
		expect(review.windowStartDate).toBe('2026-08-03'); // 90 days before Nov 1
		expect(review.targetDate).toBe('2026-10-02'); // 30 days before
		expect(review.windowEndDate).toBe('2026-10-17'); // 15 days before: the day before the 14-day mark
		expect(review.fit).toBeUndefined();
		expect(review.status).toBe('start-now'); // it fits before SkillBridge
	});

	it('the DD-214 review counts from terminal leave when it is the only date', () => {
		const review = item(leaving({ terminalLeaveStart: '2027-03-01' }), 'dd214-review');
		expect(review.windowStartDate).toBe('2026-12-01');
		expect(review.windowEndDate).toBe('2027-02-14');
	});

	it('with no leaving date the DD-214 review ends 15 days before separation', () => {
		const review = item(leaving({}), 'dd214-review');
		expect(review.windowStartDate).toBe('2027-01-30');
		expect(review.targetDate).toBe('2027-03-31');
		expect(review.windowEndDate).toBe('2027-04-15');
	});
});

describe('todayMarkerIndex (Today divider placement)', () => {
	// Phases are ordered furthest-out first; the marker renders before the first phase that is NOT
	// fully in the past (endOffset > todayOffset). todayOffset = days from EAOS to today (negative =
	// before separation), the same sign convention as the bucket offsets.
	const phases = [
		{ bucket: { endOffset: -540 } },
		{ bucket: { endOffset: -365 } },
		{ bucket: { endOffset: -180 } },
		{ bucket: { endOffset: -90 } },
		{ bucket: { endOffset: 0 } },
		{ bucket: { endOffset: 730 } }
	];

	it('places the marker before the first phase that extends past today', () => {
		expect(todayMarkerIndex(phases, -300)).toBe(2); // today inside 12-6mo -> marker before it
	});

	it('places the marker at the top when every phase is still upcoming', () => {
		expect(todayMarkerIndex(phases, -1000)).toBe(0);
	});

	it('places the marker after the last phase when every phase is in the past', () => {
		expect(todayMarkerIndex(phases, 1000)).toBe(phases.length);
	});
});

describe('generateTimeline Today marker', () => {
	it('exposes todayMarkerIndex between the past phases and the current/upcoming ones', () => {
		const defs: TaskDef[] = [
			{ ...universal, id: 'early', recommendedOffset: -400, windowStart: -420, windowEnd: -380 },
			{ ...universal, id: 'late', recommendedOffset: -100, windowStart: -120, windowEnd: -80 }
		];
		const today = new Date('2026-06-19T12:00:00Z'); // ~300 days before EAOS 2027-04-15
		const view = generateTimeline(eaosOnly, defs, { schemaVersion: 1, tasks: {} }, today);
		expect(view.phases.map((p) => p.bucket.id)).toEqual(['18-12mo', '6-3mo']);
		expect(view.todayMarkerIndex).toBe(1); // marker before the 6-3mo phase (today is in the gap)
	});

	it('omits todayMarkerIndex for a none persona (empty view, no EAOS)', () => {
		const view = generateTimeline(
			{ completeness: 'none' } as PersonaFilters,
			[universal],
			{ schemaVersion: 1, tasks: {} },
			new Date('2026-06-19T12:00:00Z')
		);
		expect(view.todayMarkerIndex).toBeUndefined();
	});

	it('exposes todayDate (the ISO date the view was generated for)', () => {
		const view = generateTimeline(
			eaosOnly,
			[universal],
			{ schemaVersion: 1, tasks: {} },
			new Date('2026-06-19T12:00:00Z')
		);
		expect(view.todayDate).toBe('2026-06-19');
	});

	it('omits todayDate for a none persona', () => {
		const view = generateTimeline(
			{ completeness: 'none' } as PersonaFilters,
			[universal],
			{ schemaVersion: 1, tasks: {} },
			new Date('2026-06-19T12:00:00Z')
		);
		expect(view.todayDate).toBeUndefined();
	});

	it('exposes daysToSeparation (whole days from today to EAOS)', () => {
		const today = new Date('2026-06-19T12:00:00Z');
		const view = generateTimeline(eaosOnly, [universal], { schemaVersion: 1, tasks: {} }, today);
		expect(view.daysToSeparation).toBe(daysUntilSeparation(EAOS, today));
	});

	it('omits daysToSeparation for a none persona', () => {
		const view = generateTimeline(
			{ completeness: 'none' } as PersonaFilters,
			[universal],
			{ schemaVersion: 1, tasks: {} },
			new Date('2026-06-19T12:00:00Z')
		);
		expect(view.daysToSeparation).toBeUndefined();
	});
});

// Today is the date on the user's clock. On the evening of a last day in Los Angeles the UTC date is already the
// day after, and on the next morning in Tokyo the UTC date is still the last day.
describe('deriveStatus and generateTimeline on the device clock', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});
	const bddWindow: AnchoredTask = {
		def: { ...universal, kind: 'closes' },
		sortOffset: -120,
		targetDate: '2026-09-01',
		windowStartDate: '2026-07-22',
		windowEndDate: '2026-10-20',
		separationDate: '2027-01-18'
	};

	it('keeps a window open through the evening of its last day in Los Angeles', () => {
		vi.stubEnv('TZ', 'America/Los_Angeles');
		const evening = new Date('2026-10-21T03:00:00Z');
		expect(evening.getHours()).toBe(20); // the zone took effect
		expect(deriveStatus(bddWindow, undefined, evening)).toBe('closing-soon');
	});

	it('closes a window on the morning after its last day in Tokyo', () => {
		vi.stubEnv('TZ', 'Asia/Tokyo');
		const morning = new Date('2026-10-20T23:30:00Z');
		expect(morning.getHours()).toBe(8); // the zone took effect
		expect(deriveStatus(bddWindow, undefined, morning)).toBe('closed');
	});

	it('builds the view for the local date, so the last day counts as today', () => {
		vi.stubEnv('TZ', 'America/Los_Angeles');
		const evening = new Date('2026-10-21T03:00:00Z'); // 20:00 on Oct 20
		const eaos = '2027-01-18' as EaosString; // a -90 window ends Oct 20, 2026
		const bdd: TaskDef = {
			...universal,
			id: 'bdd',
			kind: 'closes',
			windowStart: -180,
			windowEnd: -90
		};
		const persona: PersonaFilters = { completeness: 'eaos-only', eaos, daysUntilSeparation: 90 };
		const view = generateTimeline(persona, [bdd], { schemaVersion: 1, tasks: {} }, evening);
		const [item] = view.phases.flatMap((p) => p.items);
		expect(view.todayDate).toBe('2026-10-20');
		expect(item?.status).toBe('closing-soon');
		expect(item?.daysLeft).toBe(0);
		expect(view.daysToSeparation).toBe(90);
	});
});

describe('deriveStatus (window kinds)', () => {
	const on = (iso: string) => new Date(`${iso}T12:00:00Z`);
	const firm = (kind: TaskDef['kind'], extra: Partial<AnchoredTask> = {}): AnchoredTask => ({
		def: { ...universal, kind },
		sortOffset: -120,
		targetDate: '2026-09-01',
		windowStartDate: '2026-07-22',
		windowEndDate: '2026-10-20',
		separationDate: '2027-01-18',
		...extra
	});

	it('is upcoming the day before the window opens and open on opening day', () => {
		expect(deriveStatus(firm('closes'), undefined, on('2026-07-21'))).toBe('upcoming');
		expect(deriveStatus(firm('closes'), undefined, on('2026-07-22'))).toBe('start-now');
	});

	it('turns closing-soon 30 days before a firm last day, through the last day', () => {
		expect(deriveStatus(firm('closes'), undefined, on('2026-09-19'))).toBe('start-now');
		expect(deriveStatus(firm('closes'), undefined, on('2026-09-20'))).toBe('closing-soon');
		expect(deriveStatus(firm('required'), undefined, on('2026-10-20'))).toBe('closing-soon');
	});

	it('is closed the day after a closing date, and late the day after a required one', () => {
		expect(deriveStatus(firm('closes'), undefined, on('2026-10-21'))).toBe('closed');
		expect(deriveStatus(firm('required'), undefined, on('2026-10-21'))).toBe('late');
	});

	// A required task belongs to the time before separation; once separation has passed, nothing about it can
	// still be done, so it stops reading as late.
	it('keeps a required task late through separation day, then closes it', () => {
		expect(deriveStatus(firm('required'), undefined, on('2027-01-18'))).toBe('late');
		expect(deriveStatus(firm('required'), undefined, on('2027-01-19'))).toBe('closed');
		// A task required after separation stays late past its own date.
		const afterSeparation = firm('required', { windowEndDate: '2027-03-01' });
		expect(deriveStatus(afterSeparation, undefined, on('2027-03-02'))).toBe('late');
	});

	it('never shows closing-soon for a soft task, and is still-to-do after its window', () => {
		expect(deriveStatus(firm('soft'), undefined, on('2026-10-19'))).toBe('start-now');
		expect(deriveStatus(firm('soft'), undefined, on('2026-10-21'))).toBe('still-to-do');
	});

	it('is changed between two edges and closed after the final one', () => {
		const vgli = firm('closes', { windowEndDate: '2027-09-15', finalEndDate: '2028-05-17' });
		expect(deriveStatus(vgli, undefined, on('2027-09-16'))).toBe('changed');
		expect(deriveStatus(vgli, undefined, on('2028-05-17'))).toBe('changed');
		expect(deriveStatus(vgli, undefined, on('2028-05-18'))).toBe('closed');
	});

	it('lets a snooze quiet an open firm task, but never hide closing-soon, late, changed or closed', () => {
		const snoozed: TimelineTaskState = { status: 'snoozed', snoozeUntil: '2027-12-31' };
		expect(deriveStatus(firm('closes'), snoozed, on('2026-08-15'))).toBe('snoozed');
		expect(deriveStatus(firm('closes'), snoozed, on('2026-10-01'))).toBe('closing-soon');
		expect(deriveStatus(firm('required'), snoozed, on('2026-10-21'))).toBe('late');
		expect(deriveStatus(firm('closes'), snoozed, on('2026-10-21'))).toBe('closed');
		const vgli = firm('closes', { windowEndDate: '2027-09-15', finalEndDate: '2028-05-17' });
		expect(deriveStatus(vgli, snoozed, on('2027-09-16'))).toBe('changed');
	});

	it('still quiets a soft task past its window', () => {
		const snoozed: TimelineTaskState = { status: 'snoozed', snoozeUntil: '2027-12-31' };
		expect(deriveStatus(firm('soft'), snoozed, on('2026-10-21'))).toBe('snoozed');
	});

	// Every kind at every boundary of its window (opens Jul 22, last day Oct 20): the day before opening, opening
	// day, 31 and 30 days before the last day, the last day, and the day after.
	it.each([
		['soft', ['upcoming', 'start-now', 'start-now', 'start-now', 'start-now', 'still-to-do']],
		['required', ['upcoming', 'start-now', 'start-now', 'closing-soon', 'closing-soon', 'late']],
		['closes', ['upcoming', 'start-now', 'start-now', 'closing-soon', 'closing-soon', 'closed']]
	] as const)('walks a %s task through every boundary', (kind, expected) => {
		const days = [
			'2026-07-21',
			'2026-07-22',
			'2026-09-19',
			'2026-09-20',
			'2026-10-20',
			'2026-10-21'
		];
		expect(days.map((d) => deriveStatus(firm(kind), undefined, on(d)))).toEqual(expected);
	});

	it('walks a two-edge task through both edges', () => {
		const vgli = firm('closes', { windowEndDate: '2027-09-15', finalEndDate: '2028-05-17' });
		const days = [
			'2027-08-15',
			'2027-08-16',
			'2027-09-15',
			'2027-09-16',
			'2028-05-17',
			'2028-05-18'
		];
		expect(days.map((d) => deriveStatus(vgli, undefined, on(d)))).toEqual([
			'start-now',
			'closing-soon',
			'closing-soon',
			'changed',
			'changed',
			'closed'
		]);
	});
});

describe('generateTimeline (deadline fields)', () => {
	const today = new Date('2026-10-03T12:00:00Z');
	const eaos = '2027-01-18' as EaosString;
	const persona: PersonaFilters = { completeness: 'eaos-only', eaos, daysUntilSeparation: 107 };
	const state: TimelineState = { schemaVersion: 1, tasks: {} };
	const items = (p: PersonaFilters, defs: TaskDef[]) =>
		generateTimeline(p, defs, state, today).phases.flatMap((ph) => ph.items);
	const vgli: TaskDef = {
		...universal,
		id: 'vgli',
		kind: 'closes',
		windowStart: 0,
		windowEnd: 240,
		recommendedOffset: 30,
		finalEnd: 485
	};

	it('closes a required pre-separation task for a user already separated', () => {
		const separated = '2026-09-03' as EaosString; // 30 days before Oct 3
		const required: TaskDef = {
			...universal,
			id: 'required',
			kind: 'required',
			windowStart: -180,
			windowEnd: -90,
			afterNote: 'n'
		};
		const persona: PersonaFilters = {
			completeness: 'eaos-only',
			eaos: separated,
			daysUntilSeparation: -30
		};
		const [item] = items(persona, [required]);
		expect(item?.status).toBe('closed');
	});

	it('anchors a second edge and counts the days left to the next firm edge', () => {
		const bdd: TaskDef = {
			...universal,
			id: 'bdd',
			kind: 'closes',
			windowStart: -180,
			windowEnd: -90
		};
		const [first, second] = items(persona, [bdd, vgli]);
		expect(first?.status).toBe('closing-soon');
		expect(first?.daysLeft).toBe(17); // Oct 3 -> Oct 20
		expect(second?.finalEndDate).toBe('2028-05-17'); // 485 days after Jan 18, 2027
		expect(second?.daysLeft).toBeUndefined(); // upcoming: no countdown
	});

	it('aims a soft task at its recommended date, then at its window end once that has passed', () => {
		const ahead: TaskDef = {
			...universal,
			id: 'ahead',
			windowStart: -200,
			windowEnd: -30,
			recommendedOffset: -60
		};
		const passed: TaskDef = {
			...universal,
			id: 'passed',
			windowStart: -730,
			windowEnd: -90,
			recommendedOffset: -540
		};
		const byId = new Map(items(persona, [ahead, passed]).map((i) => [i.def.id, i]));
		expect(byId.get('ahead')?.aimDate).toBe(eaosOffsetDate(eaos, -60));
		expect(byId.get('passed')?.aimDate).toBe(eaosOffsetDate(eaos, -90));
	});

	it('counts a two-edge task down to its final edge between the edges, and lists it as closing soon', () => {
		const separated = '2025-06-25' as EaosString; // the final edge (485 days) falls on Oct 23, 2026
		const p: PersonaFilters = {
			completeness: 'eaos-only',
			eaos: separated,
			daysUntilSeparation: -465
		};
		const list = items(p, [vgli]);
		expect(list[0]?.status).toBe('changed');
		expect(list[0]?.daysLeft).toBe(20);
		expect(selectNeedsNow(list, '2026-10-03').closingSoon.map((i) => i.def.id)).toEqual(['vgli']);
	});

	// VA counts VGLI's last day as 485 days after separation. Read as a calendar year and 120 days, a Feb 29 inside the
	// span would make it a day later, so the leap-day case is where a calendar count would show; the real task is used
	// so the date under test is the one a user sees.
	describe('the VGLI final edge', () => {
		const real = TASK_DEFS.filter((d) => d.id === 'vgli-convert');
		const vgliOn = (separation: string, day: Date) => {
			const e = separation as EaosString;
			const p: PersonaFilters = {
				completeness: 'eaos-only',
				eaos: e,
				daysUntilSeparation: daysUntilSeparation(e, day)
			};
			const [item] = generateTimeline(p, real, state, day).phases.flatMap((ph) => ph.items);
			return item;
		};

		it('ends 485 days after separation across a Feb 29', () => {
			expect(vgliOn('2027-04-30', today)?.finalEndDate).toBe('2028-08-27');
		});

		it('ends 485 days after separation where no Feb 29 falls between', () => {
			expect(vgliOn('2025-06-25', today)?.finalEndDate).toBe('2026-10-23');
		});

		it('is still changed on the 485th day and closed the day after', () => {
			expect(vgliOn('2027-04-30', new Date(2028, 7, 27, 12))?.status).toBe('changed');
			expect(vgliOn('2027-04-30', new Date(2028, 7, 28, 12))?.status).toBe('closed');
		});
	});

	it('aims a soft task at a recommended date that falls today', () => {
		const dueToday: TaskDef = {
			...universal,
			id: 'due-today',
			windowStart: -200,
			windowEnd: -30,
			recommendedOffset: -107 // Oct 3, 2026
		};
		const [item] = items(persona, [dueToday]);
		expect(item?.aimDate).toBe('2026-10-03');
	});
});

describe('After you leave', () => {
	const SEP = '2027-04-30' as EaosString;
	const at = (today: Date, leaving: object, state: TimelineState['tasks'] = {}) =>
		generateTimeline(
			{ completeness: 'eaos-only', eaos: SEP, daysUntilSeparation: 208, leaving: leaving as never },
			[...TASK_DEFS],
			{ schemaVersion: 1, tasks: state },
			today
		)
			.phases.flatMap((p) => p.items)
			.reduce<Record<string, string>>((m, i) => ({ ...m, [i.def.id]: i.status }), {});
	const OCT_4 = new Date(2026, 9, 4, 12);

	it('a snooze quiets a soft task that cannot fit', () => {
		const s = at(
			OCT_4,
			{ skillbridgeStart: '2026-11-01' },
			{ 'reference-letters': { status: 'snoozed', snoozeUntil: '2026-11-20' } }
		);
		expect(s['reference-letters']).toBe('snoozed');
	});

	it('a snooze never hides a firm task that cannot fit', () => {
		const s = at(
			OCT_4,
			{ terminalLeaveStart: '2026-11-15' },
			{ 'sha-complete': { status: 'snoozed', snoozeUntil: '2026-11-20' } }
		);
		expect(s['sha-complete']).toBe('after-you-leave');
	});

	it('ends at separation: the next day the official window decides', () => {
		const s = at(new Date(2027, 4, 2, 12), {
			skillbridgeStart: '2026-11-01',
			terminalLeaveStart: '2026-11-15'
		});
		expect(s['sha-complete']).toBe('closed'); // required, official last day Jan 30, separation passed
		expect(s['reference-letters']).toBe('still-to-do'); // soft, official window ended Mar 31
	});

	// Once separation has passed, a task that could not fit is judged by its official window, so it shows that window's
	// last day, not the pulled-in day before its own opening.
	it('after separation shows a task that could not fit by its official last day', () => {
		const on = (today: Date) => {
			const items = generateTimeline(
				{
					completeness: 'eaos-only',
					eaos: SEP,
					daysUntilSeparation: 208,
					leaving: { skillbridgeStart: '2026-11-01', terminalLeaveStart: '2026-11-15' } as never
				},
				[...TASK_DEFS],
				{ schemaVersion: 1, tasks: {} },
				today
			).phases.flatMap((p) => p.items);
			return (id: string) => items.find((i) => i.def.id === id);
		};
		const after = on(new Date(2027, 4, 2, 12));
		expect(after('reference-letters')?.windowEndDate).toBe('2027-03-31');
		expect(after('reference-letters')?.aimDate).toBe('2027-03-31');
		expect(after('sha-complete')?.windowEndDate).toBe('2027-01-30');
		// On separation day it is still "after you leave", and keeps the day it was pulled in to.
		expect(on(new Date(2027, 3, 30, 12))('sha-complete')?.windowEndDate).toBe('2026-11-14');
	});

	it('holds through separation day and hands over the day after', () => {
		const leave = { terminalLeaveStart: '2026-11-15' };
		expect(at(new Date(2027, 3, 30, 12), leave)['sha-complete']).toBe('after-you-leave');
		expect(at(new Date(2027, 4, 1, 12), leave)['sha-complete']).toBe('closed');
	});

	// The date and the status change on the same local midnight: the last minute of separation day keeps the pulled-in
	// day, the first minute of the next day shows the official one.
	it('shows the official last day from the first minute after separation day', () => {
		const sha = (today: Date) =>
			generateTimeline(
				{
					completeness: 'eaos-only',
					eaos: SEP,
					daysUntilSeparation: 208,
					leaving: { terminalLeaveStart: '2026-11-15' } as never
				},
				[...TASK_DEFS],
				{ schemaVersion: 1, tasks: {} },
				today
			)
				.phases.flatMap((p) => p.items)
				.find((i) => i.def.id === 'sha-complete');
		const lastMinute = sha(new Date(2027, 3, 30, 23, 59));
		expect([lastMinute?.status, lastMinute?.windowEndDate]).toEqual([
			'after-you-leave',
			'2026-11-14'
		]);
		const firstMinute = sha(new Date(2027, 4, 1, 0, 0));
		expect([firstMinute?.status, firstMinute?.windowEndDate]).toEqual(['closed', '2027-01-30']);
	});

	// Only a task that could not fit is judged by its official window after separation; one that fit keeps its
	// pulled-in last day and the reason for it.
	it('after separation a task that fit keeps its pulled-in last day', () => {
		const capstone = generateTimeline(
			{
				completeness: 'eaos-only',
				eaos: SEP,
				daysUntilSeparation: 208,
				leaving: { skillbridgeStart: '2026-11-01' } as never
			},
			[...TASK_DEFS],
			{ schemaVersion: 1, tasks: {} },
			new Date(2027, 4, 2, 12)
		)
			.phases.flatMap((p) => p.items)
			.find((i) => i.def.id === 'tap-capstone');
		expect(capstone?.windowEndDate).toBe('2026-10-31');
		expect(capstone?.fit).toEqual({ reason: 'skillbridge', date: '2026-10-31' });
	});
});

describe('the SkillBridge steps follow the saved answer', () => {
	const STEPS = ['skillbridge-find', 'skillbridge-request'];
	const TODAY_EARLY = new Date(2026, 9, 7, 12); // before the second ask of Jun 30, 2028 (Apr 1, 2027)
	const view = (tasks: TimelineState['tasks'], leaving?: object, sep = '2028-06-30') =>
		generateTimeline(
			{
				completeness: 'eaos-only',
				eaos: sep as EaosString,
				daysUntilSeparation: 0,
				...(leaving ? { leaving: leaving as never } : {})
			},
			[...TASK_DEFS],
			{ schemaVersion: 1, tasks },
			TODAY_EARLY
		);
	const ids = (tasks: TimelineState['tasks'], leaving?: object) =>
		view(tasks, leaving)
			.phases.flatMap((p) => p.items)
			.map((i) => i.def.id);

	it('hides both steps with no answer, after No and after an early Not sure', () => {
		for (const answer of [
			undefined,
			{ status: 'skipped' as const },
			{ status: 'snoozed' as const, snoozeUntil: '2027-04-01' }
		]) {
			const shown = ids(answer ? { [SKILLBRIDGE_PLAN_KEY]: answer } : {});
			for (const id of STEPS) expect(shown, JSON.stringify(answer)).not.toContain(id);
		}
	});

	it('still builds a view, without the steps, when the saved answer is null', () => {
		const damaged = { [SKILLBRIDGE_PLAN_KEY]: null } as unknown as TimelineState['tasks'];
		const shown = ids(damaged);
		expect(shown.length).toBeGreaterThan(0);
		for (const id of STEPS) expect(shown).not.toContain(id);
	});

	it('shows both steps after Yes and after a Not sure from the second ask', () => {
		for (const answer of [{ status: 'done' as const }, { status: 'snoozed' as const }]) {
			const shown = ids({ [SKILLBRIDGE_PLAN_KEY]: answer });
			for (const id of STEPS) expect(shown, JSON.stringify(answer)).toContain(id);
		}
	});

	// Every profile level that carries a separation date reads the same saved answer: a fuller profile must neither
	// show the steps with no answer nor lose them after a Yes.
	const SEPARATION = '2028-06-30' as EaosString;
	const PERSONAS: Record<string, PersonaFilters> = {
		'eaos-only': { completeness: 'eaos-only', eaos: SEPARATION, daysUntilSeparation: 632 },
		partial: { completeness: 'partial', eaos: SEPARATION, daysUntilSeparation: 632, rate: 'IT' },
		complete: { ...completeSchool, eaos: SEPARATION, daysUntilSeparation: 632 }
	};
	const idsFor = (persona: PersonaFilters, tasks: TimelineState['tasks']) =>
		generateTimeline(persona, [...TASK_DEFS], { schemaVersion: 1, tasks }, TODAY_EARLY)
			.phases.flatMap((p) => p.items)
			.map((i) => i.def.id);

	it('hides both steps for every profile level with no answer, after No and after an early Not sure', () => {
		for (const [level, persona] of Object.entries(PERSONAS)) {
			for (const answer of [
				undefined,
				{ status: 'skipped' as const },
				{ status: 'snoozed' as const, snoozeUntil: '2027-04-01' }
			]) {
				const shown = idsFor(persona, answer ? { [SKILLBRIDGE_PLAN_KEY]: answer } : {});
				expect(shown.length, level).toBeGreaterThan(0);
				for (const id of STEPS) {
					expect(shown, `${level} ${JSON.stringify(answer)}`).not.toContain(id);
				}
			}
		}
	});

	it('shows both steps for every profile level after Yes and after a Not sure from the second ask', () => {
		for (const [level, persona] of Object.entries(PERSONAS)) {
			for (const answer of [{ status: 'done' as const }, { status: 'snoozed' as const }]) {
				const shown = idsFor(persona, { [SKILLBRIDGE_PLAN_KEY]: answer });
				for (const id of STEPS) {
					expect(shown, `${level} ${JSON.stringify(answer)}`).toContain(id);
				}
			}
		}
	});

	it('a SkillBridge date alone adds no step', () => {
		const shown = ids({}, { skillbridgeStart: '2028-01-03' });
		for (const id of STEPS) expect(shown).not.toContain(id);
	});

	it('a person with no profile gets an empty view even with a saved Yes', () => {
		const v = generateTimeline(
			{ completeness: 'none' },
			[...TASK_DEFS],
			{ schemaVersion: 1, tasks: { [SKILLBRIDGE_PLAN_KEY]: { status: 'done' } } },
			TODAY_EARLY
		);
		expect(v.phases).toEqual([]);
		expect(v.total).toBe(0);
	});

	it('counts only the tasks it shows', () => {
		const v = view({});
		expect(v.total).toBe(v.phases.reduce((n, p) => n + p.items.length, 0));
	});

	it('marks both steps, and only them; no task uses the answer key', () => {
		expect(
			TASK_DEFS.filter((t) => t.skillbridgeStep)
				.map((t) => t.id)
				.sort()
		).toEqual(STEPS);
		expect(TASK_DEFS.map((t) => t.id)).not.toContain(SKILLBRIDGE_PLAN_KEY);
	});

	// A real start is at most 180 days out, later than both windows' ends, so it never moves them; this start is set
	// earlier on purpose to prove the steps fit before leaving like every 'leaving' task.
	it('fits the request before an early SkillBridge start and leaves the search window alone', () => {
		const items = view(
			{ [SKILLBRIDGE_PLAN_KEY]: { status: 'done' } },
			{ skillbridgeStart: '2027-09-01' }
		).phases.flatMap((p) => p.items);
		const find = items.find((i) => i.def.id === 'skillbridge-find');
		const request = items.find((i) => i.def.id === 'skillbridge-request');
		expect(find?.windowStartDate).toBe('2027-05-01');
		expect(find?.windowEndDate).toBe('2027-07-01');
		expect(request?.windowStartDate).toBe('2027-07-02');
		expect(request?.windowEndDate).toBe('2027-08-31');
		expect(request?.fit).toEqual({ reason: 'skillbridge', date: '2027-08-31' });
	});
});
