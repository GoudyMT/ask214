import { afterEach, describe, it, expect, vi } from 'vitest';
import {
	filterAndAnchor,
	deriveStatus,
	generateTimeline,
	openingWord,
	todayMarkerIndex,
	type AnchoredTask
} from './generate';
import { selectNeedsNow } from './needs-now';
import { TASK_DEFS } from './task-defs';
import { SKILLBRIDGE_PLAN_KEY } from './skillbridge-plan';
import { eaosOffsetDate, daysUntilSeparation, type EaosString } from '../profile/eaos';
import { addDays, daysBetween, localTodayIso } from './day-math';
import type { PersonaFilters } from '../profile/persona';
import type { SeparationPath } from '../profile/separation-path';
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

const eaosOnly: PersonaFilters = {
	completeness: 'eaos-only',
	eaos: EAOS,
	daysUntilSeparation: 100
};

describe('filterAndAnchor (gate + anchor)', () => {
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

	// Today is Jun 4, 2026 and these windows end on Jan 15 and Jan 25, 2027, so they are still ahead: a date rule that
	// ignored the status would read the days since a window end as negative, call each task just closed, and keep the
	// phase open.
	it('folds a phase whose tasks were all done before their windows end', () => {
		const defs = [mk('a', -120), mk('a2', -110)];
		const state: TimelineState = {
			schemaVersion: 1,
			tasks: { a: { status: 'done' }, a2: { status: 'done' } }
		};
		const phase = generateTimeline(persona, defs, state, today).phases[0];
		expect(phase?.collapsible).toBe(true);
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

	// A required task stays late until separation, so its real last day is the separation date, not its window end
	// months earlier: the 14 days its card stays reachable run from separation.
	describe('a required task closed by separation', () => {
		const required: TaskDef = {
			...mk('req', -120),
			kind: 'required',
			windowEnd: -90, // ends 90 days before separation
			afterNote: 'n'
		};
		const done = mk('d', -110);
		const state: TimelineState = { schemaVersion: 1, tasks: { d: { status: 'done' } } };
		const afterSeparation = (days: number) => {
			const view = generateTimeline(
				persona,
				[required, done],
				state,
				new Date(`${addDays(EAOS, days)}T12:00:00Z`)
			);
			expect(view.phases.length).toBe(1);
			return view.phases[0];
		};

		it('is dated closed on the separation date, and keeps its phase open for 14 days', () => {
			const phase = afterSeparation(1);
			const item = phase?.items.find((i) => i.def.id === 'req');
			expect(item?.status).toBe('closed');
			expect(phase?.collapsible).toBe(false);
			expect(afterSeparation(14)?.collapsible).toBe(false);
			expect(item?.closedOn).toBe(EAOS);
		});

		it('lets the phase fold on the 15th day after separation', () => {
			expect(afterSeparation(15)?.collapsible).toBe(true);
		});

		it('leaves closedOn off a task that is not required, and off one that is not closed', () => {
			const closes: TaskDef = { ...required, id: 'cl', kind: 'closes' };
			const items = generateTimeline(
				persona,
				[required, closes, done],
				state,
				new Date(`${addDays(EAOS, 1)}T12:00:00Z`)
			).phases.flatMap((p) => p.items);
			const byId = (id: string) => items.find((i) => i.def.id === id);
			expect(byId('cl')?.status).toBe('closed');
			expect(byId('cl')?.closedOn).toBeUndefined();
			expect(byId('d')?.status).toBe('done');
			expect(byId('d')?.closedOn).toBeUndefined();
		});

		it('leaves closedOn off a required task that is still late on separation day', () => {
			const lateItem = afterSeparation(0)?.items.find((i) => i.def.id === 'req');
			expect(lateItem?.status).toBe('late');
			expect(lateItem?.closedOn).toBeUndefined();
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
		expect(pkg.status).toBe('still-to-do'); // a recommended step past its window, never "late"
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
		expect(pkg.status).toBe('start-now'); // 28 days left, but a recommended step never says "closing soon"
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

	it('the DD-214 review counts from SkillBridge when terminal leave follows it, like the separation package', () => {
		const review = item(
			leaving({ skillbridgeStart: '2026-11-01', terminalLeaveStart: '2027-03-01' }),
			'dd214-review'
		);
		expect(review.windowStartDate).toBe('2026-08-03');
		expect(review.windowEndDate).toBe('2026-10-17');
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

	// Once the leaving day has come, "ask your command" no longer applies, and an opening already past is not news.
	describe('once the user has left the command', () => {
		const item = (today: Date) =>
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

		it('carries nothing before the leaving day', () => {
			const sha = item(new Date(2026, 10, 14, 12));
			expect(sha?.status).toBe('after-you-leave');
			expect(sha?.leftCommand).toBeUndefined();
		});

		it('says the user has left from the leaving day, and whether the window has opened', () => {
			const onLeaving = item(new Date(2026, 10, 15, 12));
			expect(onLeaving?.status).toBe('after-you-leave');
			expect(onLeaving?.leftCommand).toEqual({
				opened: onLeaving!.windowStartDate <= '2026-11-15'
			});
			const opened = item(new Date(2027, 3, 1, 12));
			expect((opened?.windowStartDate ?? '9999-12-31') <= '2027-04-01').toBe(true);
			expect(opened?.leftCommand).toEqual({ opened: true });
		});
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

// A task that must be done before the user leaves the command, snoozed past that day, stayed quiet after they had
// left. The snooze now ends on the task's last day there, the same promise a firm warning keeps.
describe('A snooze on a task moved to fit before leaving', () => {
	// The window runs Oct 17, 2026 to Jan 15, 2027; SkillBridge from Dec 1 moves its last day to Nov 30.
	const atCommand: TaskDef = { ...universal, finishBefore: 'leaving' };
	const on = (today: Date, snoozeUntil = '2027-01-10') =>
		generateTimeline(
			{
				completeness: 'eaos-only',
				eaos: EAOS,
				daysUntilSeparation: 0,
				leaving: { skillbridgeStart: '2026-12-01' } as never
			},
			[atCommand],
			{ schemaVersion: 1, tasks: { u1: { status: 'snoozed', snoozeUntil } } },
			today
		).phases.flatMap((p) => p.items)[0];

	it('holds until the last day there, showing that day as its end', () => {
		const u1 = on(new Date(2026, 10, 29, 12));
		expect(u1?.windowEndDate).toBe('2026-11-30');
		expect(u1?.status).toBe('snoozed');
		expect(u1?.snoozeUntil).toBe('2026-11-30');
	});

	it('ends on the last day there', () => {
		const u1 = on(new Date(2026, 10, 30, 12));
		expect(u1?.status).toBe('start-now');
		expect(u1?.snoozeUntil).toBeUndefined();
	});

	it('stays ended once the user has left', () => {
		expect(on(new Date(2026, 11, 2, 12))?.status).toBe('still-to-do');
	});

	// From the last day there no snooze can quiet it, so the card must not offer one that does nothing.
	it('closes snoozing from the last day there on, and not before', () => {
		expect(on(new Date(2026, 10, 29, 12))?.snoozeClosed).toBeUndefined();
		expect(on(new Date(2026, 10, 30, 12))?.snoozeClosed).toBe(true);
		expect(on(new Date(2026, 11, 2, 12))?.snoozeClosed).toBe(true);
	});

	it('keeps a snooze that ends before the last day there as it is', () => {
		const u1 = on(new Date(2026, 10, 1, 12), '2026-11-10');
		expect(u1?.status).toBe('snoozed');
		expect(u1?.snoozeUntil).toBe('2026-11-10');
	});
});

// A soft task never closes, so years later its card would still say "Aimed for" a date from before separation.
describe('A soft aim from before separation', () => {
	const afterSeparation: TaskDef = {
		...noRecommended,
		id: 'after',
		windowStart: 30,
		windowEnd: 60
	};
	const onSeparation: TaskDef = {
		...noRecommended,
		id: 'on-separation',
		windowStart: -30,
		windowEnd: 0
	};
	const on = (today: Date) => {
		const items = generateTimeline(
			{ completeness: 'eaos-only', eaos: EAOS, daysUntilSeparation: 0 },
			[universal, afterSeparation, onSeparation],
			{ schemaVersion: 1, tasks: {} },
			today
		).phases.flatMap((p) => p.items);
		return (id: string) => items.find((i) => i.def.id === id);
	};

	it('keeps its date through separation day', () => {
		const u1 = on(new Date(2027, 3, 15, 12))('u1');
		expect(u1?.status).toBe('still-to-do');
		expect(u1?.aimLapsed).toBeUndefined();
	});

	it('lapses the day after separation', () => {
		const u1 = on(new Date(2027, 3, 16, 12))('u1');
		expect(u1?.status).toBe('still-to-do');
		expect(u1?.aimLapsed).toBe(true);
	});

	it('lapses an aim set on separation day itself, the day after', () => {
		expect(on(new Date(2027, 3, 15, 12))('on-separation')?.aimLapsed).toBeUndefined();
		const day = on(new Date(2027, 3, 16, 12))('on-separation');
		expect(day?.status).toBe('still-to-do');
		expect(day?.aimLapsed).toBe(true);
	});

	it('never lapses an aim set after separation', () => {
		const after = on(new Date(2029, 5, 1, 12))('after');
		expect(after?.status).toBe('still-to-do');
		expect(after?.aimLapsed).toBeUndefined();
	});

	it('marks no task that is not still to do', () => {
		const u1 = generateTimeline(
			{ completeness: 'eaos-only', eaos: EAOS, daysUntilSeparation: 0 },
			[universal],
			{ schemaVersion: 1, tasks: { u1: { status: 'done' } } },
			new Date(2029, 5, 1, 12)
		).phases.flatMap((p) => p.items)[0];
		expect(u1?.status).toBe('done');
		expect(u1?.aimLapsed).toBeUndefined();
	});
});

describe('the school step', () => {
	// No screen asks whether a member plans to go to school, so the step shows for every member, with the condition in
	// its title: the Home row and the calendar show only the title.
	it('shows for every member, with or without a leaving answer, its condition leading the title', () => {
		for (const path of [
			undefined,
			'ets',
			'retirement',
			'reserve-retirement',
			'medical',
			'reserve-component'
		] as const) {
			const persona: PersonaFilters = { ...eaosOnly, ...(path ? { separationPath: path } : {}) };
			const school = filterAndAnchor(persona, [...TASK_DEFS]).find(
				(a) => a.def.id === 'school-apply'
			);
			expect(school?.def.title, String(path)).toBe(
				'If you plan to go to school, apply and submit the FAFSA'
			);
		}
	});
});

describe('the leaving answer gates its own tasks', () => {
	const pathTask: TaskDef = { ...universal, id: 'p1', requires: { separationPath: ['medical'] } };
	const hiddenFor: TaskDef = { ...universal, id: 'h1', hideFor: ['reserve-component'] };
	const persona = (separationPath?: SeparationPath): PersonaFilters => ({
		...eaosOnly,
		...(separationPath ? { separationPath } : {})
	});
	const gated = (p: PersonaFilters) =>
		filterAndAnchor(p, [pathTask, hiddenFor]).map((i) => i.def.id);

	it('shows a path task only for a stored, listed path', () => {
		expect(gated(persona())).toEqual(['h1']);
		expect(gated(persona('retirement'))).toEqual(['h1']);
		expect(gated(persona('medical'))).toEqual(['p1', 'h1']);
	});

	it('hides a hideFor task only for a stored, listed path', () => {
		expect(gated(persona('reserve-component'))).toEqual([]);
		expect(gated(persona('ets'))).toEqual(['h1']);
	});

	it("words a task for a stored, listed path and keeps every other answer's wording", () => {
		const worded: TaskDef = {
			...universal,
			id: 'w1',
			why: 'base',
			copyFor: { medical: { why: 'board' } }
		};
		const why = (p: PersonaFilters) => filterAndAnchor(p, [worded])[0]?.def.why;
		expect(why(persona('medical'))).toBe('board');
		expect(why(persona('retirement'))).toBe('base');
		expect(why(persona())).toBe('base');
	});
});

describe('the leaving answer on the real task list', () => {
	const TODAY = new Date(2026, 9, 31, 12);
	const SEP = '2028-06-30' as EaosString;
	const TRACKS: Record<SeparationPath, string[]> = {
		ets: [],
		// A Guard or Reserve retirement makes the Reserve SBP choice; a board can retire a member, who then makes the SBP one.
		retirement: [
			'sbp-election',
			'retirement-request',
			'rcsbp-election',
			'tricare-retiree-enroll',
			'fedvip-dental'
		],
		medical: [
			'peblo-contact',
			'va-msc-claim',
			'ides-review-options',
			'sbp-election',
			'tricare-retiree-enroll',
			'fedvip-dental'
		],
		'reserve-component': ['tamp-check', 'rcsbp-election'],
		// A Guard or Reserve retiree makes the Reserve SBP choice, or the active-duty one when retiring from full-time
		// active duty (10 USC 1448(a)(2)), and asks when to file.
		'reserve-retirement': [
			'retirement-request',
			'tamp-check',
			'rcsbp-election',
			'sbp-election',
			'tricare-retiree-enroll',
			'fedvip-dental'
		]
	};
	const TAP = ['preseparation-counseling', 'tap-course', 'tap-track', 'tap-capstone'];
	const items = (separationPath?: SeparationPath, tasks: TimelineState['tasks'] = {}) =>
		generateTimeline(
			{
				completeness: 'eaos-only',
				eaos: SEP,
				daysUntilSeparation: 0,
				...(separationPath ? { separationPath } : {})
			},
			[...TASK_DEFS],
			{ schemaVersion: 1, tasks },
			TODAY
		).phases.flatMap((p) => p.items);
	const ids = (separationPath?: SeparationPath) => items(separationPath).map((i) => i.def.id);
	const trackIds = Object.values(TRACKS).flat();

	it('with no answer shows no track task, and the Reserve or Guard reminder', () => {
		const shown = ids();
		for (const id of trackIds) expect(shown).not.toContain(id);
		expect(shown).toContain('reserve-affiliation');
		expect(ids('ets')).toEqual(shown);
	});

	it.each(Object.entries(TRACKS) as [SeparationPath, string[]][])(
		'the %s answer adds exactly its own track',
		(path, own) => {
			const added = ids(path).filter((id) => !ids().includes(id));
			expect(added.sort()).toEqual([...own].sort());
		}
	);

	// A member on active-duty orders keeps the firm TAP deadlines; the condition says when they apply, so a member
	// leaving drill status can tell they may not.
	it.each(['reserve-component', 'reserve-retirement'] as const)(
		'the %s answer keeps the TAP steps, says when they apply, and hides only the recruiter reminder',
		(path) => {
			const shown = items(path);
			expect(shown.map((i) => i.def.id)).not.toContain('reserve-affiliation');
			// The Home row, Needs you now and the calendar show only the title, so the condition leads it; the why names
			// the statute's exceptions (10 USC 1142(a)(4)) and who confirms; a late card says it only if TAP applies.
			for (const id of TAP) {
				const def = shown.find((i) => i.def.id === id)?.def;
				const plain = items().find((i) => i.def.id === id)?.def;
				expect(def?.title, id).toMatch(/^If you are leaving active duty orders, [a-z]/);
				expect(def?.why, id).toContain('180 days in a row');
				expect(def?.why, id).toContain('Your transition assistance office confirms what you need.');
				if (plain?.afterNote)
					expect(def?.afterNote, id).toMatch(/^If TAP applies to you, it is still required/);
				expect(`${plain?.title} ${plain?.why} ${plain?.afterNote ?? ''}`, id).not.toMatch(
					/orders|applies to you/
				);
			}
		}
	);

	// va.gov's BDD page: "You're a service member on full-time active duty (including a member of the National Guard,
	// Reserve, or Coast Guard)". A Guard or Reserve member leaving drill status cannot use BDD, so the step says when it
	// applies; every other answer keeps the plain step.
	it.each(['reserve-component', 'reserve-retirement'] as const)(
		'the %s answer says BDD is for full-time active duty',
		(path) => {
			const bdd = items(path).find((i) => i.def.id === 'va-bdd-claim')?.def;
			const plain = items().find((i) => i.def.id === 'va-bdd-claim')?.def;
			expect(bdd?.title).toBe(
				'If you are on full-time active duty, file your VA disability claim through BDD (Benefits Delivery at Discharge)'
			);
			expect(bdd?.why).toBe(
				`BDD is for members on full-time active duty, the Guard and Reserve included. ${plain?.why}`
			);
			expect(bdd?.kind).toBe('closes');
			// A member who left drill status never had BDD, so the late note may not say it is "no longer" there.
			expect(bdd?.afterNote).toBe(
				'If BDD applied to you, it is no longer available. A VA claim can still be filed the standard way, and an accredited VSO helps for free.'
			);
			for (const other of ['ets', 'retirement', 'medical'] as const) {
				expect(items(other).find((i) => i.def.id === 'va-bdd-claim')?.def.title).toBe(plain?.title);
			}
		}
	);

	// A DD-214 records a release from active duty, a paid move follows orders, and leave builds only in active service
	// (10 USC 701(a)), so a Guard or Reserve member leaving drill status has none of them. Neither answer says which
	// status the member leaves from, so the condition leads the title (the Home row and the calendar show only that).
	it.each(['reserve-component', 'reserve-retirement'] as const)(
		'the %s answer says the DD-214, move and leave steps need active duty orders',
		(path) => {
			const def = (id: string, p?: typeof path) => items(p).find((i) => i.def.id === id)?.def;
			const lead = (title: string | undefined) =>
				`If you are leaving active duty orders, ${title?.charAt(0).toLowerCase()}${title?.slice(1)}`;
			const DD214 =
				'A DD-214 covers time on active duty or full-time National Guard duty orders, not drill status; your personnel office confirms whether one is issued.';
			for (const id of ['dd214-review', 'dd214-copies']) {
				expect(def(id, path)?.title, id).toBe(lead(def(id)?.title));
				expect(def(id, path)?.why, id).toBe(`${DD214} ${def(id)?.why}`);
			}
			expect(def('hhg-counseling', path)?.title).toBe(lead(def('hhg-counseling')?.title));
			expect(def('hhg-counseling', path)?.why).toBe(
				'Your orders set whether a government-paid move is covered; your transportation office confirms.'
			);
			expect(def('hhg-counseling', path)?.afterNote).toBe(
				'If your orders covered a move, your installation transportation office says how long it lasts.'
			);
			expect(def('final-pay-check', path)?.title).toBe(
				'Verify your final pay and any terminal-leave settlement'
			);
			expect(def('final-pay-check', path)?.why).toBe(
				'Leave builds during active service (active duty or full-time National Guard duty), not drill periods; your pay office settles any leave you have. Final-pay errors are common and worth catching.'
			);
			expect(def('separation-package', path)?.title).toBe(def('separation-package')?.title);
			expect(def('separation-package', path)?.why).toBe(
				'Your personnel office prepares your discharge or transfer orders and confirms whether a DD-214 is issued. Ask them early for their list and deadline.'
			);
		}
	);

	// DTM 14-006 ties the exam to time on active duty (180 days, or a contingency tour over 30), and later Guard and
	// Reserve guidance could not be read, so a Guard or Reserve member is told the step may not apply and who confirms
	// it, never that leaving orders makes it required; every other answer keeps the plain step.
	it.each(['reserve-component', 'reserve-retirement'] as const)(
		'the %s answer says the separation exam may not apply and who confirms it',
		(path) => {
			for (const id of ['sha-schedule', 'sha-complete']) {
				const shown = items(path).find((i) => i.def.id === id)?.def;
				const plain = items().find((i) => i.def.id === id)?.def;
				expect(shown?.title, id).toBe(
					`If you need one, ${plain?.title.charAt(0).toLowerCase()}${plain?.title.slice(1)}`
				);
				expect(shown?.why, id).toBe(
					`For the Guard or Reserve, whether you need a separation exam depends on your orders and how you leave; your military medical clinic confirms it. ${plain?.why}`
				);
				expect(shown?.afterNote, id).toBe(
					'If you need one, it is still required before you separate. Contact your military medical clinic.'
				);
				expect(shown?.kind, id).toBe('required');
				for (const other of ['ets', 'retirement'] as const) {
					const def = items(other).find((i) => i.def.id === id)?.def;
					expect(`${def?.title} ${def?.why} ${def?.afterNote}`, id).not.toMatch(
						/drill|orders|If you need one/
					);
				}
			}
		}
	);

	// 38 CFR 3.400(b)(2)(i): "Day following separation from active service ... if claim is received within 1 year", where
	// separation means from the continuous active service in which the disability was incurred or aggravated. A member
	// leaving drill status has no separation from active service that day, so the year counts from that release.
	it.each(['reserve-component', 'reserve-retirement'] as const)(
		'the %s answer counts the claim year from the release from active service',
		(path) => {
			const def = (p?: SeparationPath) =>
				items(p).find((i) => i.def.id === 'va-claim-fallback')?.def;
			expect(def(path)?.why).toBe(
				'If you did not file through BDD: for a claim VA receives within 1 year of your release from the active service in which your condition began or got worse, the effective date can be as early as the day after that release.'
			);
			expect(def(path)?.title).toBe(def()?.title);
			expect(def('ets')?.why).toBe(def()?.why);
		}
	);

	// va.gov's BDD page says IDES gives a member found unfit a proposed VA rating, and names no IDES exclusion from BDD;
	// no source read says who picks the route, so the board member is sent to the coordinator who helps them file.
	it('tells a board member who to ask which way to file their claim', () => {
		const def = (p?: SeparationPath) => items(p).find((i) => i.def.id === 'va-bdd-claim')?.def;
		const line =
			'In the medical board process, ask your VA Military Service Coordinator which way to file; they help service members file their VA claim.';
		expect(def('medical')?.why).toBe(`${def()?.why} ${line}`);
		expect(def('medical')?.title).toBe(def()?.title);
		for (const other of [undefined, 'ets', 'retirement'] as const) {
			expect(def(other)?.why).not.toContain('Military Service Coordinator');
		}
	});

	// No source read says every service's board runs through IDES, so the PEBLO step names IDES as one example.
	it('names IDES as one disability evaluation process, not the only one', () => {
		const why = items('medical').find((i) => i.def.id === 'peblo-contact')?.def.why;
		expect(why).toBe(
			'A Physical Evaluation Board Liaison Officer (PEBLO) guides service members through the disability evaluation process, such as the Integrated Disability Evaluation System (IDES). If the process moves your separation date, update it here.'
		);
	});

	// The Coast Guard Pay and Personnel Center: "The tool available to all military members each payday is the Direct
	// Access Payslip." The title reaches the calendar, so it names no one service's site.
	it('names the pay account for every branch, the Coast Guard included', () => {
		const def = items().find((i) => i.def.id === 'financial-docs')?.def;
		expect(def?.title).toBe('Save your LES history, pay account access, and SGLI election');
		expect(def?.why).toBe(
			'You lose easy access to military pay records after you separate. Coast Guard members use Direct Access instead of myPay.'
		);
	});

	it.each(['ets', 'retirement', 'medical'] as const)(
		'the %s answer keeps the plain DD-214, move and leave steps',
		(path) => {
			for (const id of [
				'dd214-review',
				'dd214-copies',
				'hhg-counseling',
				'final-pay-check',
				'separation-package'
			]) {
				const shown = items(path).find((i) => i.def.id === id)?.def;
				const plain = items().find((i) => i.def.id === id)?.def;
				expect(shown?.title, id).toBe(plain?.title);
				expect(shown?.why, id).toBe(plain?.why);
				expect(shown?.afterNote, id).toBe(plain?.afterNote);
				// The plain step is the active-duty one: no Guard or Reserve condition reaches it.
				expect(`${shown?.title} ${shown?.why} ${shown?.afterNote ?? ''}`, id).not.toMatch(
					/drill|active duty orders|full-time|covered a move/
				);
			}
		}
	);

	// tricare.mil: 90 days after the retirement date to enroll, a retroactive request up to 12 months from it.
	it.each([
		['the day before retirement', new Date(2028, 5, 29, 12), 'upcoming'],
		['the retirement date', new Date(2028, 5, 30, 12), 'start-now'],
		['day 90', new Date(2028, 8, 28, 12), 'closing-soon'],
		['day 91', new Date(2028, 8, 29, 12), 'changed'],
		['day 365', new Date(2029, 5, 30, 12), 'changed'],
		['day 366', new Date(2029, 6, 1, 12), 'closed']
	] as const)('reads the retiree TRICARE step on %s', (_name, today, status) => {
		const view = generateTimeline(
			{
				completeness: 'eaos-only',
				eaos: SEP,
				daysUntilSeparation: 0,
				separationPath: 'retirement'
			},
			[...TASK_DEFS],
			{ schemaVersion: 1, tasks: {} },
			today
		);
		const item = view.phases
			.flatMap((p) => p.items)
			.find((i) => i.def.id === 'tricare-retiree-enroll');
		expect(item?.status).toBe(status);
	});

	it('says what a member can still do once each TRICARE edge passes', () => {
		const def = (path: SeparationPath) =>
			items(path).find((i) => i.def.id === 'tricare-retiree-enroll')?.def;
		// The title reaches the calendar file, so a title of the medical answer's own would mark the file as a board
		// member's: the two answers share one.
		expect(def('retirement')?.title).toBe(
			'If you retire, enroll in a TRICARE plan within 90 days after your retirement date'
		);
		expect(def('medical')?.title).toBe(def('retirement')?.title);
		// A board can separate a member instead, so neither note says flatly that they can enroll.
		for (const path of ['retirement', 'medical'] as const) {
			expect(def(path)?.changeNote).toMatch(
				/^If you retired, you can ask for retroactive enrollment up to 12 months/
			);
			expect(def(path)?.afterNote).toMatch(
				/^If you retired, you can enroll during TRICARE Open Season/
			);
		}
		// 10 USC 1201(b)(3): 20 years of service retires a member under a 30% rating, so no rating decides this line.
		expect(def('medical')?.why).toMatch(/^If the board retires you/);
		expect(def('medical')?.why).toMatch(/If the board separates you instead/);
		expect(def('medical')?.why).not.toMatch(/30%/);
		// tricare.mil's Retiring page: a member eligible for Medicare must have Part B to stay eligible for TRICARE when
		// they retire - a rule on its own, not a second step after enrolling, and in place by the retirement. tricare.mil's
		// medical retirement page gives a member the board retires the same 90 days, Guard or Reserve included, so the
		// Guard or Reserve line points only a member the board does not retire to tricare.mil.
		expect(def('medical')?.why).toBe(
			'If the board retires you, enroll within 90 days after your retirement date to keep TRICARE with no break. If Medicare applies to you, you must have Part B to stay eligible when you retire. If the board separates you instead, or you are in the Guard or Reserve and it does not retire you, tricare.mil lists what may apply.'
		);
		// A Guard or Reserve member can hold the Retiring answer from before their own answer existed. The card prints the
		// why above its note, so the line is in the why alone and a board member's notes stay free of it.
		expect(def('retirement')?.why).toMatch(/A Guard or Reserve retirement works differently/);
		for (const path of ['retirement', 'medical'] as const) {
			expect(def(path)?.changeNote).not.toMatch(/works differently/);
			expect(def(path)?.afterNote).not.toMatch(/works differently/);
		}
		expect(def('reserve-retirement')?.title).toBe(
			'Check your TRICARE plan within 90 days of your retirement date'
		);
		// This answer holds two members: one leaving full-time active duty keeps the retiree routes, a drill-status one
		// has TRICARE Retired Reserve. Each note says which is whose.
		for (const note of [
			def('reserve-retirement')?.changeNote,
			def('reserve-retirement')?.afterNote
		]) {
			expect(note).toMatch(/^If you are retiring from full-time active duty, you can/);
			expect(note).toMatch(/Members who qualify can buy TRICARE Retired Reserve at any time/);
		}
		expect(def('reserve-retirement')?.changeNote).toContain('any fees go back to that date');
	});

	// A retiree stays on TRICARE, so "coverage for after TRICARE" is not their step; the others may really leave it.
	it('hides the after-TRICARE coverage step for a retiree only', () => {
		expect(ids('retirement')).not.toContain('tricare-elect');
		for (const path of [
			undefined,
			'ets',
			'medical',
			'reserve-component',
			'reserve-retirement'
		] as const) {
			expect(ids(path)).toContain('tricare-elect');
		}
	});

	// BENEFEDS's fact sheet for retiring members (BEN10320 v.8): a member retiring from active duty may enroll in FEDVIP
	// dental from 31 days before the retirement date to 60 days after; enrolling before that date avoids a gap; after
	// the 60 days, the next open season. The Air Force's FEDVIP sheet adds "Retired Reserve members who are age 60 and
	// older and under age 60 (gray area reservists)" and gives the window for "retiring from the uniformed services"
	// without saying which date starts it for a transfer to the Retired Reserve, so that member is sent to BENEFEDS for
	// it. A board can separate a member instead of retiring them.
	it('gives a retiring member the FEDVIP dental step with its window and what is left after each edge', () => {
		const def = (path: SeparationPath) =>
			items(path).find((i) => i.def.id === 'fedvip-dental')?.def;
		const retiring = def('retirement');
		// The closing edges are pinned with their source in task-defs.test.ts.
		expect(retiring).toMatchObject({
			title: 'If you retire, enroll in FEDVIP dental before your retirement date',
			windowStart: -31
		});
		expect(retiring?.why).toBe(
			'Most retirees can buy dental coverage through FEDVIP, on BENEFEDS.gov. Enrollment opens 31 days before your retirement date; enroll before that date to avoid a gap in dental coverage.'
		);
		expect(retiring?.changeNote).toBe(
			'If you retired, you can still enroll within 60 days after your retirement date, with a gap in dental coverage until the plan starts.'
		);
		expect(retiring?.afterNote).toBe(
			'If you retired and missed the 60 days, you can enroll during the Federal Benefits Open Season, each November into December.'
		);
		expect(def('medical')?.why).toBe(`If the board retires you from active duty: ${retiring?.why}`);
		// The title reaches the calendar file, so the two answers share it.
		expect(def('medical')?.title).toBe(retiring?.title);
		expect(def('medical')?.changeNote).toBe(retiring?.changeNote);
		expect(def('medical')?.afterNote).toBe(retiring?.afterNote);
		const guard = def('reserve-retirement');
		expect(guard?.why).toBe(
			'Retired Guard and Reserve members, including those under 60 not yet drawing retired pay, can buy dental coverage through FEDVIP, on BENEFEDS.gov. For a member retiring from the uniformed services, enrollment opens 31 days before the retirement date; BENEFEDS.gov confirms which date starts your window.'
		);
		expect(guard?.title).toBe(retiring?.title);
		expect(guard?.changeNote).toBe(retiring?.changeNote);
		expect(guard?.afterNote).toBe(retiring?.afterNote);
	});

	// A source sets these openings for a member retiring from active duty only: for the Guard or Reserve retirement no
	// source read names the day FEDVIP opens, and TRICARE Retired Reserve can be bought at any time, so that answer is
	// told when to start, never that a window opens.
	it.each(['fedvip-dental', 'tricare-retiree-enroll'])(
		'says when to start %s for a Guard or Reserve retiree, and Opens for the others',
		(id) => {
			const def = (path: SeparationPath) => items(path).find((i) => i.def.id === id)?.def;
			const guard = def('reserve-retirement');
			expect(guard && openingWord(guard)).toBe('Start');
			for (const path of ['retirement', 'medical'] as const) {
				const shown = def(path);
				expect(shown && openingWord(shown), path).toBe('Opens');
			}
		}
	);

	// The step lands above the retiree TRICARE step for these two answers, and either can end in a retirement that
	// keeps TRICARE, so its first words send that member on. A drill-status retiree's TRICARE Reserve Select ends when
	// they transfer to the Retired Reserve (tricare.mil), so this step stays theirs. The title stays shared: it reaches
	// the calendar file.
	it('tells a board or Guard or Reserve retiree that the after-TRICARE step may not be theirs', () => {
		const def = (path?: SeparationPath) =>
			items(path).find((i) => i.def.id === 'tricare-elect')?.def;
		const base = def('ets')?.why;
		expect(def('medical')?.why).toBe(
			`If the board retires you, check the TRICARE step tied to your retirement date first: this step is for a member whose TRICARE ends. ${base}`
		);
		expect(def('reserve-retirement')?.why).toBe(
			`If you are retiring from full-time active duty, check the TRICARE step tied to your retirement date first: this step is for a member whose TRICARE ends. ${base}`
		);
		for (const path of ['medical', 'reserve-retirement'] as const) {
			expect(def(path)?.title).toBe(def('ets')?.title);
			expect(def(path)?.afterNote).toBe(def('ets')?.afterNote);
		}
		for (const path of [undefined, 'ets', 'reserve-component'] as const) {
			expect(def(path)?.why).toBe(base);
		}
	});

	// 10 USC 1142(a)(3)(B): a separation not known until 365 or fewer days remain starts counseling as soon as possible.
	const OTHER_ANSWERS = ['ets', 'retirement', 'reserve-component', 'reserve-retirement'] as const;
	it.each(['preseparation-counseling', 'tap-course', 'tap-track', 'tap-capstone'])(
		'tells a board member, and only a board member, to start %s early if the date moves up',
		(id) => {
			const def = (path: SeparationPath) => items(path).find((i) => i.def.id === id)?.def;
			const line =
				'If the board moves your date up, start as soon as you can; your transition assistance office says what fits.';
			expect(def('medical')?.why.endsWith(line)).toBe(true);
			expect(def('medical')?.title).toBe(def('ets')?.title);
			for (const path of OTHER_ANSWERS) expect(def(path)?.why).not.toMatch(/board/);
		}
	);

	it.each(['sha-schedule', 'sha-complete'])(
		'tells a board member, and only a board member, the board exams may stand in for %s',
		(id) => {
			const def = (path: SeparationPath) => items(path).find((i) => i.def.id === id)?.def;
			const line =
				'If the board finds you unfit, its exams may stand in for this one; your PEBLO can confirm.';
			expect(def('medical')?.why.endsWith(line)).toBe(true);
			// The note a late card shows must not say the opposite of that line.
			expect(def('medical')?.afterNote).toMatch(
				/^Still required before you separate, unless the board's exams stand in/
			);
			expect(def('medical')?.title).toBe(def('ets')?.title);
			for (const path of OTHER_ANSWERS) {
				expect(def(path)?.why).not.toMatch(/board/);
				// A Guard or Reserve answer's note says it only if the exam applies; its own test pins that line.
				expect(def(path)?.afterNote).toMatch(
					/^(If you need one, it is still|Still) required before you separate\. Contact/
				);
			}
		}
	);

	// The member updated the date after a board moved it up: the steps re-time, and a step whose window has gone stays
	// on the list as late, with what to do, rather than closed.
	it('reads Capstone and the SHA as late once a moved date leaves too little time', () => {
		const view = generateTimeline(
			{
				completeness: 'eaos-only',
				eaos: '2027-01-15' as EaosString,
				daysUntilSeparation: 76,
				separationPath: 'medical'
			},
			[...TASK_DEFS],
			{ schemaVersion: 1, tasks: {} },
			TODAY
		);
		const moved = view.phases.flatMap((p) => p.items);
		const notes = {
			'tap-capstone': /^Still required before you separate/,
			'sha-schedule': /^Still required before you separate, unless the board's exams stand in/,
			'sha-complete': /^Still required before you separate, unless the board's exams stand in/
		};
		for (const [id, note] of Object.entries(notes)) {
			const item = moved.find((i) => i.def.id === id);
			expect(item?.status, id).toBe('late');
			expect(item?.def.afterNote, id).toMatch(note);
		}
	});

	// A drill-status retiree makes the Reserve choice, so each line of the active-duty step says when it applies.
	it('conditions every line of the active-duty SBP step for a Guard or Reserve retiree', () => {
		const def = items('reserve-retirement').find((i) => i.def.id === 'sbp-election')?.def;
		expect(def?.why).toMatch(/^If you are retiring from full-time active duty, the SBP choice/);
		expect(def?.afterNote).toMatch(
			/^If you are retiring from full-time active duty and retired pay has begun/
		);
	});

	// A member who has both steps needs a place to ask; the rule for full-time active duty is not settled here.
	it('sends a Guard or Reserve retiree with both SBP steps to the office that says which applies', () => {
		const def = (path: SeparationPath) =>
			items(path).find((i) => i.def.id === 'rcsbp-election')?.def;
		const line = 'Your retirement services office says which SBP choice applies to you.';
		expect(def('reserve-retirement')?.why.endsWith(line)).toBe(true);
		expect(def('reserve-component')?.why).not.toContain(line);
	});

	// A member who never had BDD, such as a drill-status member, did not miss it.
	it('does not say a member missed a BDD window they may never have had', () => {
		const why = items().find((i) => i.def.id === 'va-claim-fallback')?.def.why;
		expect(why).toMatch(/^If you did not file through BDD:/);
		expect(why).not.toMatch(/missed/);
	});

	it('says when the SBP steps apply to a medical board and to a retirement', () => {
		const def = (path: SeparationPath, id: string) => items(path).find((i) => i.def.id === id)?.def;
		expect(def('medical', 'sbp-election')?.why).toMatch(/^If the board retires you/);
		expect(def('retirement', 'sbp-election')?.why).not.toMatch(/board/);
		expect(def('retirement', 'rcsbp-election')?.title).toMatch(
			/^If you are retiring from the Guard or Reserve/
		);
		expect(def('reserve-component', 'rcsbp-election')?.title).toMatch(
			/^If you have your 20-year letter/
		);
		expect(def('reserve-retirement', 'rcsbp-election')?.title).toMatch(
			/^If you are retiring from the Guard or Reserve/
		);
		// A drill-status retiree makes only the Reserve choice, so the active-duty step says when it applies.
		expect(def('reserve-retirement', 'sbp-election')?.title).toBe(
			'If you are retiring from full-time active duty, get Survivor Benefit Plan counseling and make your SBP choice'
		);
		expect(def('retirement', 'sbp-election')?.title).toBe(
			'Get Survivor Benefit Plan counseling and make your SBP choice'
		);
		// Retired pay from the Guard or Reserve usually starts at 60, so the line after the date cannot say it began.
		expect(def('retirement', 'sbp-election')?.afterNote).toMatch(/^If retired pay has begun/);
	});

	// 10 USC 1142(a)(3): "as soon as possible during the 24-month period preceding the anticipated retirement date".
	it.each(['retirement', 'reserve-retirement'] as const)(
		'the %s answer opens counseling two years out and keeps its 365-day deadline',
		(path) => {
			const counseling = (p?: SeparationPath) =>
				items(p).find((i) => i.def.id === 'preseparation-counseling');
			expect(counseling(path)?.windowStartDate).toBe(eaosOffsetDate(SEP, -730));
			expect(counseling(path)?.targetDate).toBe(eaosOffsetDate(SEP, -600));
			expect(counseling(path)?.windowEndDate).toBe(eaosOffsetDate(SEP, -365));
			expect(counseling(path)?.def.kind).toBe('required');
			expect(counseling()?.windowStartDate).toBe(eaosOffsetDate(SEP, -540));
		}
	);

	it('keeps a track task done after the answer changes and changes back (state is kept by id)', () => {
		const tasks = { 'sbp-election': { status: 'done' as const } };
		expect(items('ets', tasks).some((i) => i.def.id === 'sbp-election')).toBe(false);
		expect(items('retirement', tasks).find((i) => i.def.id === 'sbp-election')?.status).toBe(
			'done'
		);
	});
});
