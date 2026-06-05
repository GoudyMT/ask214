import { describe, it, expect } from 'vitest';
import { filterAndAnchor, deriveStatus, type AnchoredTask } from './generate';
import { eaosOffsetDate, type EaosString } from '../profile/eaos';
import type { PersonaFilters } from '../profile/persona';
import type { TaskDef, TimelineTaskState } from './types';

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
