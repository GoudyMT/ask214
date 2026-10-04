import { afterEach, describe, it, expect, vi } from 'vitest';
import {
	filterAndAnchor,
	deriveStatus,
	generateTimeline,
	todayMarkerIndex,
	type AnchoredTask
} from './generate';
import { selectNeedsNow } from './needs-now';
import { eaosOffsetDate, daysUntilSeparation, type EaosString } from '../profile/eaos';
import type { PersonaFilters } from '../profile/persona';
import type { TaskDef, TimelineTaskState, TimelineState } from './types';

const EAOS = '2027-04-15' as EaosString;

const universal: TaskDef = {
	id: 'u1',
	title: 'Universal task',
	category: 'admin',
	track: 'transition',
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
	track: 'transition',
	kind: 'soft',
	windowStart: -60,
	windowEnd: -30,
	why: 'w'
};

const gatedSchool: TaskDef = {
	id: 'g1',
	title: 'School-only task',
	category: 'career',
	track: 'transition',
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
		effectiveOffset: -120,
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
		track: 'transition',
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
		expect(phase?.counts).toEqual({ done: 1, skipped: 1, snoozed: 0, toDo: 0 });
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

describe('generateTimeline SkillBridge shift', () => {
	const emptyState: TimelineState = { schemaVersion: 1, tasks: {} };
	const today = new Date('2026-06-04T12:00:00Z');
	const noSkillBridge: PersonaFilters = {
		completeness: 'eaos-only',
		eaos: EAOS,
		daysUntilSeparation: 100
	};
	const skillBridge90: PersonaFilters = {
		completeness: 'eaos-only',
		eaos: EAOS,
		daysUntilSeparation: 100,
		skillbridge: { approved: true, durationDays: 90 }
	};
	const militaryTask: TaskDef = {
		id: 'm1',
		title: 'Military task',
		category: 'admin',
		track: 'military',
		kind: 'soft',
		windowStart: -120,
		windowEnd: -90,
		recommendedOffset: -120,
		why: 'w'
	};
	const transitionTask: TaskDef = { ...militaryTask, id: 't1', track: 'transition' };

	const firstItem = (p: PersonaFilters, defs: TaskDef[]) =>
		generateTimeline(p, defs, emptyState, today).phases.flatMap((ph) => ph.items)[0];

	it('left-shifts a military-track task by the SkillBridge duration', () => {
		expect(firstItem(noSkillBridge, [militaryTask])?.targetDate).toBe(eaosOffsetDate(EAOS, -120));
		expect(firstItem(skillBridge90, [militaryTask])?.targetDate).toBe(eaosOffsetDate(EAOS, -210));
	});

	it('does not shift a transition-track task', () => {
		expect(firstItem(skillBridge90, [transitionTask])?.targetDate).toBe(eaosOffsetDate(EAOS, -120));
	});

	it('does not shift when SkillBridge is not approved (baseline)', () => {
		expect(firstItem(noSkillBridge, [militaryTask])?.targetDate).toBe(eaosOffsetDate(EAOS, -120));
	});

	it('shifts the window dates uniformly with the target date', () => {
		const item = firstItem(skillBridge90, [militaryTask]);
		expect(item?.windowStartDate).toBe(eaosOffsetDate(EAOS, -210));
		expect(item?.windowEndDate).toBe(eaosOffsetDate(EAOS, -180));
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
		effectiveOffset: -120,
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
		effectiveOffset: -120,
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

	// SkillBridge moves a military task earlier, not the separation itself: a required task stays late until the
	// real separation date has passed.
	it('keeps a SkillBridge-shifted required task late until the real separation', () => {
		const shifted: PersonaFilters = {
			completeness: 'eaos-only',
			eaos: '2026-11-02' as EaosString,
			daysUntilSeparation: 30,
			skillbridge: { approved: true, durationDays: 90 }
		};
		const required: TaskDef = {
			...universal,
			id: 'required',
			track: 'military',
			kind: 'required',
			windowStart: -180,
			windowEnd: -90,
			afterNote: 'n'
		};
		const [item] = items(shifted, [required]);
		expect(item?.windowEndDate).toBe('2026-05-06'); // 180 days before separation: long past on Oct 3
		expect(item?.status).toBe('late');
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
		expect(second?.finalEndDate).toBe(eaosOffsetDate(eaos, 485));
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

	it('moves the second edge with the SkillBridge shift, like the window', () => {
		const shifted: PersonaFilters = {
			...persona,
			skillbridge: { approved: true, durationDays: 90 }
		};
		const [item] = items(shifted, [{ ...vgli, track: 'military' }]);
		expect(item?.finalEndDate).toBe(eaosOffsetDate(eaos, 485 - 90));
	});

	it('derives the status and the countdown from the SkillBridge-shifted window', () => {
		const shifted: PersonaFilters = {
			...persona,
			skillbridge: { approved: true, durationDays: 30 }
		};
		const military: TaskDef = {
			...universal,
			id: 'military',
			track: 'military',
			kind: 'closes',
			windowStart: -180,
			windowEnd: -60
		};
		// Unshifted, the last day is Nov 19 (47 days out); 30 days earlier it is Oct 20.
		const [item] = items(shifted, [military]);
		expect(item?.status).toBe('closing-soon');
		expect(item?.daysLeft).toBe(17);
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
