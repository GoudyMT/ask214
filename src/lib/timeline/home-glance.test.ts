import { describe, it, expect } from 'vitest';
import { timelineRow } from './home-glance';
import { selectNeedsNow } from './needs-now';
import { generateTimeline, type TimelineItem, type DisplayStatus } from './generate';
import { TASK_DEFS } from './task-defs';
import type { EaosString } from '../profile/eaos';
import type { PersonaFilters } from '../profile/persona';

const TODAY = '2026-10-14';

function item(id: string, status: DisplayStatus, extra: Partial<TimelineItem> = {}): TimelineItem {
	return {
		def: {
			id,
			title: `Title of ${id}`,
			category: 'admin',
			finishBefore: 'separation',
			kind: 'closes',
			windowStart: -180,
			windowEnd: -90,
			why: ''
		},
		targetDate: '2026-09-01',
		windowStartDate: '2026-07-22',
		windowEndDate: '2026-11-20',
		status,
		...extra
	};
}
const ready = (items: TimelineItem[]) => ({ kind: 'ready' as const, items, todayIso: TODAY });

describe('timelineRow', () => {
	it('counts what needs you now and names the most urgent task with its status word', () => {
		const row = timelineRow(
			ready([
				item('opened', 'start-now', { windowStartDate: '2026-10-10' }),
				item('soon', 'closing-soon', { daysLeft: 5 }),
				item('late', 'late', { windowEndDate: '2026-10-03' })
			])
		);
		expect(row).toEqual({
			name: 'Your timeline',
			count: '3 need you now',
			status: { word: 'Late', hot: true },
			detail: 'Title of late'
		});
	});

	it('says "needs" for one task', () => {
		expect(timelineRow(ready([item('soon', 'closing-soon', { daysLeft: 5 })])).count).toBe(
			'1 needs you now'
		);
	});

	it('takes the first task in the Timeline order of urgency: late, closing soon, after you leave, just closed, just opened', () => {
		const leave = item('leave', 'after-you-leave');
		const closed = item('closed', 'closed', { windowEndDate: '2026-10-10' });
		const opened = item('opened', 'start-now', { windowStartDate: '2026-10-10' });
		const soon = item('soon', 'closing-soon', { daysLeft: 9 });
		expect(timelineRow(ready([opened, closed, leave, soon])).detail).toBe('Title of soon');
		expect(timelineRow(ready([opened, closed, leave])).status).toEqual({
			word: 'After you leave',
			hot: false
		});
		expect(timelineRow(ready([opened, closed])).status).toEqual({ word: 'Closed', hot: true });
		expect(timelineRow(ready([opened])).status).toEqual({ word: 'Start now', hot: false });
	});

	it('words a two-edge task whose final day is near as Changed', () => {
		expect(timelineRow(ready([item('vgli', 'changed', { daysLeft: 12 })])).status).toEqual({
			word: 'Changed',
			hot: true
		});
	});

	it('gives the same count as the Timeline summary on real tasks', () => {
		const persona: PersonaFilters = {
			completeness: 'eaos-only',
			eaos: '2027-01-15' as EaosString,
			daysUntilSeparation: 93
		};
		const today = new Date(2026, 9, 14);
		const view = generateTimeline(persona, [...TASK_DEFS], { schemaVersion: 1, tasks: {} }, today);
		const items = view.phases.flatMap((p) => p.items);
		const g = selectNeedsNow(items, TODAY);
		const total = Object.values(g).reduce((n, list) => n + list.length, 0);
		expect(total).toBeGreaterThan(1);
		expect(timelineRow(ready(items)).count).toBe(`${total} need you now`);
	});

	it('names the next open task and its date when nothing needs you now', () => {
		const row = timelineRow(
			ready([
				item('done', 'done'),
				item('later', 'upcoming', { windowStartDate: '2027-01-10' }),
				item('aim', 'start-now', {
					windowStartDate: '2026-08-01',
					def: { ...item('aim', 'start-now').def, kind: 'soft' },
					aimDate: '2026-12-01'
				})
			])
		);
		expect(row).toEqual({
			name: 'Your timeline',
			count: 'nothing needs you now',
			detail: 'Next: Title of aim - aim for Dec 1, 2026'
		});
	});

	it('words each kind of next date as its card does', () => {
		const next = (i: TimelineItem) => timelineRow(ready([i])).detail;
		expect(next(item('up', 'upcoming', { windowStartDate: '2027-01-10' }))).toBe(
			'Next: Title of up - opens Jan 10, 2027'
		);
		expect(next(item('firm', 'start-now', { windowStartDate: '2026-08-01' }))).toBe(
			'Next: Title of firm - last day Nov 20, 2026'
		);
		expect(
			next(item('soft', 'still-to-do', { def: { ...item('soft', 'upcoming').def, kind: 'soft' } }))
		).toBe('Next: Title of soft - aimed for Nov 20, 2026');
		expect(next(item('far', 'changed', { daysLeft: 60, finalEndDate: '2026-12-13' }))).toBe(
			'Next: Title of far - last day Dec 13, 2026'
		);
		expect(next(item('nap', 'snoozed', { snoozeUntil: '2026-11-01' }))).toBe(
			'Next: Title of nap - snoozed until Nov 1, 2026'
		);
	});

	it('names the task that opens soonest when none is open today', () => {
		const row = timelineRow(
			ready([
				item('march', 'upcoming', { windowStartDate: '2027-03-01' }),
				item('jan', 'upcoming', { windowStartDate: '2027-01-10' })
			])
		);
		expect(row.detail).toBe('Next: Title of jan - opens Jan 10, 2027');
	});

	it('names a soft task that opens after you leave by its opening date, against other later tasks', () => {
		const leave = item('leave', 'after-you-leave', {
			def: { ...item('leave', 'upcoming').def, kind: 'soft' },
			windowStartDate: '2027-01-10'
		});
		const march = item('march', 'upcoming', { windowStartDate: '2027-03-01' });
		expect(timelineRow(ready([march, leave])).detail).toBe(
			'Next: Title of leave - opens Jan 10, 2027'
		);
	});

	it('prefers an open task over a snoozed one for Next', () => {
		const row = timelineRow(
			ready([
				item('nap', 'snoozed', { snoozeUntil: '2026-11-01' }),
				item('up', 'upcoming', { windowStartDate: '2027-01-10' })
			])
		);
		expect(row.detail).toBe('Next: Title of up - opens Jan 10, 2027');
	});

	it('says all tasks are done when nothing is left to act on', () => {
		const row = timelineRow(
			ready([
				item('a', 'done'),
				item('b', 'skipped'),
				item('c', 'closed', { windowEndDate: '2026-01-01' })
			])
		);
		expect(row).toEqual({
			name: 'Your timeline',
			count: 'all tasks done',
			detail: 'See what you finished'
		});
	});

	it('shows no task title or date while locked', () => {
		const row = timelineRow({ kind: 'locked' });
		expect(row).toEqual({
			name: 'Your timeline',
			count: 'locked',
			detail: 'Unlock to see what is due'
		});
		expect(JSON.stringify(row)).not.toMatch(/Title of|20[0-9][0-9]/);
	});

	it('says it could not load, and where to go, when the timeline failed', () => {
		expect(timelineRow({ kind: 'failed' })).toEqual({
			name: 'Your timeline',
			detail: 'Could not load it here - open the Timeline'
		});
	});
});
