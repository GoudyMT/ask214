import { describe, it, expect } from 'vitest';
import { selectNeedsNow } from './needs-now';
import type { TimelineItem, DisplayStatus } from './generate';

const TODAY = '2026-10-03';

function item(id: string, status: DisplayStatus, extra: Partial<TimelineItem> = {}): TimelineItem {
	return {
		def: {
			id,
			title: id,
			category: 'admin',
			track: 'transition',
			kind: 'closes',
			windowStart: -180,
			windowEnd: -90,
			why: ''
		},
		targetDate: '2026-09-01',
		windowStartDate: '2026-07-22',
		windowEndDate: '2026-10-20',
		status,
		...extra
	};
}
const ids = (list: TimelineItem[]) => list.map((i) => i.def.id);

describe('selectNeedsNow', () => {
	it('keeps a late task however long ago its date passed', () => {
		const g = selectNeedsNow([item('l', 'late', { windowEndDate: '2026-01-01' })], TODAY);
		expect(ids(g.late)).toEqual(['l']);
	});

	it('lists closing-soon tasks, and a two-edge task whose final day is within 30 days', () => {
		const g = selectNeedsNow(
			[
				item('cs', 'closing-soon', { daysLeft: 17 }),
				item('ch-near', 'changed', { daysLeft: 30 }),
				item('ch-far', 'changed', { daysLeft: 31 })
			],
			TODAY
		);
		expect(ids(g.closingSoon)).toEqual(['cs', 'ch-near']);
	});

	it('shows a closed task for 14 days after its date, then drops it', () => {
		const g = selectNeedsNow(
			[
				item('c14', 'closed', { windowEndDate: '2026-09-19' }),
				item('c15', 'closed', { windowEndDate: '2026-09-18' }),
				item('final', 'closed', { windowEndDate: '2025-01-01', finalEndDate: '2026-09-25' })
			],
			TODAY
		);
		expect(ids(g.justClosed)).toEqual(['c14', 'final']);
	});

	it('shows a window opened in the last 14 days', () => {
		const g = selectNeedsNow(
			[
				item('o0', 'start-now', { windowStartDate: '2026-10-03' }),
				item('o13', 'start-now', { windowStartDate: '2026-09-20' }),
				item('o14', 'start-now', { windowStartDate: '2026-09-19' })
			],
			TODAY
		);
		expect(ids(g.justOpened)).toEqual(['o0', 'o13']);
	});

	it('leaves out upcoming, still-to-do, done, skipped and snoozed tasks', () => {
		const statuses: DisplayStatus[] = ['upcoming', 'still-to-do', 'done', 'skipped', 'snoozed'];
		const g = selectNeedsNow(
			statuses.map((s) => item(s, s)),
			TODAY
		);
		expect([...g.late, ...g.closingSoon, ...g.justClosed, ...g.justOpened]).toEqual([]);
	});
});
