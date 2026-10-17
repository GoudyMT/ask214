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

	// Once the leaving day has come the card, "Needs you now" and this row all say "Since you left"; a task whose
	// leaving day is still ahead keeps "After you leave" and is named first when both are there.
	it('words an after-you-leave task "Since you left" once the user has left the command', () => {
		const left = item('left', 'after-you-leave', { leftCommand: { opened: true } });
		const ahead = item('ahead', 'after-you-leave');
		expect(timelineRow(ready([left])).status).toEqual({ word: 'Since you left', hot: false });
		const both = timelineRow(ready([left, ahead]));
		expect(both.status).toEqual({ word: 'After you leave', hot: false });
		expect(both.detail).toBe('Title of ahead');
		expect(both.count).toBe('2 need you now');
	});

	it('gives the word the card gives, before and after the leaving day, on a real profile', () => {
		const persona: PersonaFilters = {
			completeness: 'eaos-only',
			eaos: '2027-04-30' as EaosString,
			daysUntilSeparation: 208,
			leaving: { terminalLeaveStart: '2026-11-15' as EaosString }
		};
		// One task alone, so nothing more urgent outranks it on the row.
		const sha = TASK_DEFS.filter((d) => d.id === 'sha-complete');
		const rowOn = (day: Date) => {
			const view = generateTimeline(persona, sha, { schemaVersion: 1, tasks: {} }, day);
			return timelineRow({
				kind: 'ready',
				items: view.phases.flatMap((p) => p.items),
				todayIso: view.todayDate!
			});
		};
		expect(rowOn(new Date(2026, 10, 14, 12)).status?.word).toBe('After you leave');
		expect(rowOn(new Date(2026, 10, 16, 12)).status?.word).toBe('Since you left');
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

	// The card stops naming an opening already past once the user has left; Home words it the same way.
	it('gives a task already open after the user left no past opening date', () => {
		const leave = item('leave', 'after-you-leave', {
			def: { ...item('leave', 'upcoming').def, kind: 'soft' },
			windowStartDate: '2026-06-01',
			leftCommand: { opened: true }
		});
		expect(timelineRow(ready([leave])).detail).toBe(
			'Next: Title of leave - by your separation date'
		);
		const notYet = { ...leave, windowStartDate: '2027-01-10', leftCommand: { opened: false } };
		expect(timelineRow(ready([notYet])).detail).toBe('Next: Title of leave - opens Jan 10, 2027');
	});

	it('names a still-to-do task with a lapsed aim without its old date', () => {
		const soft = { ...item('soft', 'upcoming').def, kind: 'soft' as const };
		const old = item('old', 'still-to-do', { def: { ...soft, id: 'old' }, aimLapsed: true });
		expect(timelineRow(ready([old])).detail).toBe('Next: Title of soft - still to do');
	});

	// An aim already passed is weaker than a window open now, whatever the list order.
	it('prefers a task open now over a still-to-do one for Next', () => {
		const soft = { ...item('soft', 'upcoming').def, kind: 'soft' as const, title: 'Old aim' };
		const old = item('old', 'still-to-do', { def: soft });
		const now = item('now', 'start-now', { windowStartDate: '2026-08-01' });
		expect(timelineRow(ready([old, now])).detail).toBe(
			'Next: Title of now - last day Nov 20, 2026'
		);
		expect(timelineRow(ready([old, item('up', 'upcoming')])).detail).toBe(
			'Next: Old aim - aimed for Nov 20, 2026'
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

	it('says all tasks are done when every task is done or skipped', () => {
		const row = timelineRow(ready([item('a', 'done'), item('b', 'skipped')]));
		expect(row).toEqual({
			name: 'Your timeline',
			count: 'all tasks done',
			detail: 'See what you finished'
		});
	});

	// A task whose window closed long ago was missed, not done: the row must not call it finished.
	it('says nothing is left to do, not that all is done, when a missed task closed long ago', () => {
		const row = timelineRow(
			ready([item('a', 'done'), item('c', 'closed', { windowEndDate: '2026-01-01' })])
		);
		expect(row).toEqual({
			name: 'Your timeline',
			count: 'nothing left to do',
			detail: 'See your timeline'
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
	// The failed row needs none of this code: Home's page tests pin it, for a failed store and for code that never came.
});
