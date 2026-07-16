import { describe, it, expect } from 'vitest';
import { computeDesiredEvents } from './desired';
import type { TimelineItem } from '../timeline/generate';
import type { TaskDef } from '../timeline/types';

function def(id: string, category: TaskDef['category'], title = id): TaskDef {
	return {
		id,
		title,
		category,
		track: 'transition',
		windowStart: -30,
		windowEnd: 0,
		why: '',
		value: ''
	};
}
function item(
	d: TaskDef,
	status: TimelineItem['status'],
	targetDate: string,
	snoozeUntil?: string
): TimelineItem {
	return {
		def: d,
		targetDate,
		windowStartDate: targetDate,
		windowEndDate: targetDate,
		status,
		...(snoozeUntil ? { snoozeUntil } : {})
	};
}

describe('computeDesiredEvents', () => {
	it('emits an all-day event per pending, non-excluded task at its target date', () => {
		const items = [item(def('a', 'admin'), 'start-now', '2026-08-14')];
		expect(computeDesiredEvents(items, { taskIds: [], categories: [] })).toEqual([
			{ taskId: 'a', title: 'a', isoDate: '2026-08-14' }
		]);
	});

	it('drops done and skipped tasks', () => {
		const items = [
			item(def('a', 'admin'), 'done', '2026-08-14'),
			item(def('b', 'admin'), 'skipped', '2026-08-14')
		];
		expect(computeDesiredEvents(items, { taskIds: [], categories: [] })).toEqual([]);
	});

	it('uses the snooze date for an actively snoozed task', () => {
		const items = [item(def('a', 'admin'), 'snoozed', '2026-08-14', '2026-09-01')];
		expect(computeDesiredEvents(items, { taskIds: [], categories: [] })[0]?.isoDate).toBe(
			'2026-09-01'
		);
	});

	it('excludes by task id and by category', () => {
		const items = [
			item(def('a', 'admin'), 'start-now', '2026-08-14'),
			item(def('m', 'medical'), 'start-now', '2026-08-14')
		];
		expect(computeDesiredEvents(items, { taskIds: ['a'], categories: ['medical'] })).toEqual([]);
	});
});
