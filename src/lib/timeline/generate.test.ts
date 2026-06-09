import { describe, it, expect } from 'vitest';
import {
	filterAndAnchor,
	deriveStatus,
	generateTimeline,
	todayMarkerIndex,
	type AnchoredTask
} from './generate';
import { eaosOffsetDate, type EaosString } from '../profile/eaos';
import type { PersonaFilters } from '../profile/persona';
import type { TaskDef, TimelineTaskState, TimelineState } from './types';

const EAOS = '2027-04-15' as EaosString;

const universal: TaskDef = {
	id: 'u1',
	title: 'Universal task',
	category: 'admin',
	track: 'transition',
	windowStart: -180,
	windowEnd: -90,
	recommendedOffset: -120,
	why: 'w',
	value: 'v'
};

const noRecommended: TaskDef = {
	id: 'n1',
	title: 'No recommended offset',
	category: 'admin',
	track: 'transition',
	windowStart: -60,
	windowEnd: -30,
	why: 'w',
	value: 'v'
};

const gatedSchool: TaskDef = {
	id: 'g1',
	title: 'School-only task',
	category: 'career',
	track: 'transition',
	windowStart: -365,
	windowEnd: -180,
	why: 'w',
	value: 'v',
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

describe('filterAndAnchor (TL-5 gate + TL-3 anchor)', () => {
	it('includes universal tasks for any persona with an EAOS', () => {
		const ids = filterAndAnchor(eaosOnly, [universal, gatedSchool]).map((i) => i.def.id);
		expect(ids).toContain('u1');
	});

	it('hides a gated task when the persona field is unset (TL-5 hide-when-unset)', () => {
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

describe('deriveStatus (TL-7 status + snooze-expiry)', () => {
	const anchored: AnchoredTask = {
		def: universal,
		effectiveOffset: -120,
		targetDate: '2027-01-15',
		windowStartDate: '2027-01-01',
		windowEndDate: '2027-03-01'
	};
	const inWindow = new Date('2027-02-01T12:00:00Z');

	it('derives "upcoming" before the window opens', () => {
		expect(deriveStatus(anchored, undefined, new Date('2026-12-01T12:00:00Z'))).toBe('upcoming');
	});

	it('derives "start-now" inside the window', () => {
		expect(deriveStatus(anchored, undefined, inWindow)).toBe('start-now');
	});

	it('derives "overdue" after the window closes', () => {
		expect(deriveStatus(anchored, undefined, new Date('2027-04-01T12:00:00Z'))).toBe('overdue');
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
		windowStart: recommendedOffset,
		windowEnd: recommendedOffset + 30,
		recommendedOffset,
		why: 'w',
		value: 'v'
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
		expect(phase?.counts?.toDo).toBe(1); // a2 derives active (overdue) -> still "to do"
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

describe('generateTimeline SkillBridge shift (TL-10)', () => {
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
		windowStart: -120,
		windowEnd: -90,
		recommendedOffset: -120,
		why: 'w',
		value: 'v'
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

describe('todayMarkerIndex (C5 Today divider placement)', () => {
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

describe('generateTimeline Today marker (C5)', () => {
	it('exposes todayMarkerIndex between the past phases and the current/upcoming ones', () => {
		const defs: TaskDef[] = [
			{ ...universal, id: 'early', recommendedOffset: -400, windowStart: -420, windowEnd: -380 },
			{ ...universal, id: 'late', recommendedOffset: -100, windowStart: -120, windowEnd: -80 }
		];
		const today = new Date('2026-06-19'); // ~300 days before EAOS 2027-04-15
		const view = generateTimeline(eaosOnly, defs, { schemaVersion: 1, tasks: {} }, today);
		expect(view.phases.map((p) => p.bucket.id)).toEqual(['18-12mo', '6-3mo']);
		expect(view.todayMarkerIndex).toBe(1); // marker before the 6-3mo phase (today is in the gap)
	});

	it('omits todayMarkerIndex for a none persona (empty view, no EAOS)', () => {
		const view = generateTimeline(
			{ completeness: 'none' } as PersonaFilters,
			[universal],
			{ schemaVersion: 1, tasks: {} },
			new Date('2026-06-19')
		);
		expect(view.todayMarkerIndex).toBeUndefined();
	});
});
