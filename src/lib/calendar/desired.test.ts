import { describe, it, expect } from 'vitest';
import { computeDesiredEvents } from './desired';
import type { TimelineItem } from '../timeline/generate';
import type { TaskDef } from '../timeline/types';

const TODAY = '2026-10-03';
const NONE = { taskIds: [], categories: [] };

function def(id: string, kind: TaskDef['kind'], extra: Partial<TaskDef> = {}): TaskDef {
	return {
		id,
		title: id,
		category: 'admin',
		finishBefore: 'separation',
		kind,
		windowStart: -180,
		windowEnd: -90,
		why: '',
		...extra
	};
}
function item(d: TaskDef, extra: Partial<TimelineItem> = {}): TimelineItem {
	return {
		def: d,
		targetDate: '2026-11-01',
		windowStartDate: '2026-11-01',
		windowEndDate: '2027-02-01',
		status: 'upcoming',
		...extra
	};
}

describe('computeDesiredEvents', () => {
	it('gives a soft task one "Aim for" event with an alert 7 days before', () => {
		const out = computeDesiredEvents(
			[item(def('a', 'soft'), { aimDate: '2026-11-01' })],
			NONE,
			TODAY
		);
		expect(out).toEqual([
			{ taskId: 'a', moment: 'aim', title: 'Aim for: a', isoDate: '2026-11-01', alarmDays: [7] }
		]);
	});

	it('moves a snoozed soft task to its snooze date', () => {
		const snoozed = item(def('a', 'soft'), {
			status: 'snoozed',
			aimDate: '2026-11-01',
			snoozeUntil: '2026-12-01'
		});
		expect(computeDesiredEvents([snoozed], NONE, TODAY)[0]?.isoDate).toBe('2026-12-01');
	});

	it('gives a firm task an "Opens" event and a "Last day" event with alerts 30, 7 and 1 days before', () => {
		expect(computeDesiredEvents([item(def('b', 'closes'))], NONE, TODAY)).toEqual([
			{ taskId: 'b', moment: 'opens', title: 'Opens: b', isoDate: '2026-11-01', alarmDays: [] },
			{
				taskId: 'b',
				moment: 'last',
				title: 'Last day: b',
				isoDate: '2027-02-01',
				alarmDays: [30, 7, 1]
			}
		]);
	});

	it('never moves a firm date with a snooze', () => {
		const snoozed = item(def('b', 'required'), { status: 'snoozed', snoozeUntil: '2027-06-01' });
		expect(computeDesiredEvents([snoozed], NONE, TODAY).map((e) => e.isoDate)).toEqual([
			'2026-11-01',
			'2027-02-01'
		]);
	});

	it('marks both edges of a two-edge task', () => {
		const vgli = item(def('v', 'closes', { finalEnd: 485 }), {
			windowEndDate: '2027-09-15',
			finalEndDate: '2028-05-17'
		});
		expect(
			computeDesiredEvents([vgli], NONE, TODAY).map((e) => [
				e.moment,
				e.title,
				e.isoDate,
				e.alarmDays
			])
		).toEqual([
			['opens', 'Opens: v', '2026-11-01', []],
			['changes', 'Changes: v', '2027-09-15', [30, 7, 1]],
			['last', 'Last day: v', '2028-05-17', [30, 7, 1]]
		]);
	});

	// An alert lands at 09:00 on its day; on the day itself that may already be past, so only later days count.
	it('drops an alert that would land today', () => {
		const inAWeek = item(def('w', 'closes'), {
			windowStartDate: '2026-01-01',
			windowEndDate: '2026-10-10',
			status: 'closing-soon'
		});
		expect(computeDesiredEvents([inAWeek], NONE, TODAY)[0]?.alarmDays).toEqual([1]);
	});

	// "Opens" tells the user a window is coming; on opening day the window is already open.
	it('gives no "Opens" event on opening day itself', () => {
		const opensToday = item(def('o', 'closes'), {
			windowStartDate: TODAY,
			windowEndDate: '2027-02-01',
			status: 'start-now'
		});
		expect(computeDesiredEvents([opensToday], NONE, TODAY).map((e) => e.moment)).toEqual(['last']);
	});

	it('keeps an event dated today, with no alert left to fire', () => {
		const lastToday = item(def('t', 'closes'), {
			windowStartDate: '2026-01-01',
			windowEndDate: TODAY,
			status: 'closing-soon'
		});
		expect(computeDesiredEvents([lastToday], NONE, TODAY)).toEqual([
			{ taskId: 't', moment: 'last', title: 'Last day: t', isoDate: TODAY, alarmDays: [] }
		]);
	});

	it('drops every event dated before today, and every alert not still ahead', () => {
		const open = item(def('c', 'closes'), {
			windowStartDate: '2026-07-22',
			windowEndDate: '2026-10-20',
			status: 'closing-soon'
		});
		const passed = item(def('d', 'required'), {
			windowStartDate: '2026-01-01',
			windowEndDate: '2026-09-01',
			status: 'late'
		});
		const softPassed = item(def('e', 'soft'), { aimDate: '2026-07-22', status: 'still-to-do' });
		// Oct 20: the 30-day alert (Sep 20) has passed; the 7- and 1-day alerts are still ahead.
		expect(computeDesiredEvents([open, passed, softPassed], NONE, TODAY)).toEqual([
			{
				taskId: 'c',
				moment: 'last',
				title: 'Last day: c',
				isoDate: '2026-10-20',
				alarmDays: [7, 1]
			}
		]);
	});

	it('drops done and skipped tasks, and every moment of an excluded one', () => {
		const out = computeDesiredEvents(
			[
				item(def('a', 'closes'), { status: 'done' }),
				item(def('b', 'closes'), { status: 'skipped' }),
				item(def('c', 'closes')),
				item(def('m', 'closes', { category: 'medical' }))
			],
			{ taskIds: ['c'], categories: ['medical'] },
			TODAY
		);
		expect(out).toEqual([]);
	});
});

describe('a task that cannot fit before leaving the command', () => {
	const cannotFit = (kind: TaskDef['kind'], lastDay: string) =>
		item(def('s', kind), {
			status: 'after-you-leave',
			windowStartDate: '2026-12-01',
			windowEndDate: lastDay
		});

	it('gets one "Before you leave" event on the last day there, with the firm alerts', () => {
		expect(computeDesiredEvents([cannotFit('required', '2026-11-14')], NONE, TODAY)).toEqual([
			{
				taskId: 's',
				moment: 'leave',
				title: 'Before you leave: s',
				isoDate: '2026-11-14',
				alarmDays: [30, 7, 1]
			}
		]);
	});

	it('a soft one gets the 7-day alert', () => {
		expect(
			computeDesiredEvents([cannotFit('soft', '2026-11-14')], NONE, TODAY)[0]?.alarmDays
		).toEqual([7]);
	});

	it('gets no event once that day has passed', () => {
		expect(computeDesiredEvents([cannotFit('required', '2026-09-30')], NONE, TODAY)).toEqual([]);
	});
});
