import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import { flushSync } from 'svelte';
import TimelineList from './TimelineList.svelte';
import type { TimelineView, TimelineItem, DisplayStatus, TaskStatus } from '$lib/timeline';

// TimelineList renders a generated TimelineView (C3): one labelled <section> per non-empty
// phase (h2 = bucket.label, id = bucket.id to seed C5 scroll-spy), each holding a TaskCard per
// item. Empty/locked/no-EAOS states are handled by the route, not here.

function makeItem(title: string, status: DisplayStatus = 'upcoming'): TimelineItem {
	return {
		def: {
			id: title.toLowerCase().replace(/[^a-z]+/g, '-'),
			title,
			category: 'admin',
			track: 'transition',
			windowStart: -120,
			windowEnd: -60,
			why: `Why ${title} matters.`,
			value: 'value'
		},
		targetDate: '2027-01-10',
		windowStartDate: '2026-12-01',
		windowEndDate: '2027-02-01',
		status
	};
}

const VIEW: TimelineView = {
	phases: [
		{
			bucket: { id: 'phase-18-12', label: '18-12 months out', startOffset: -540, endOffset: -360 },
			items: [makeItem('Request medical records')],
			count: 1,
			counts: { done: 0, skipped: 0, snoozed: 0, toDo: 1 },
			collapsible: false
		},
		{
			bucket: { id: 'phase-final-90', label: 'Final 90 days', startOffset: -90, endOffset: 0 },
			items: [makeItem('File VA intent-to-file', 'overdue'), makeItem('DD-214 review')],
			count: 2,
			counts: { done: 0, skipped: 0, snoozed: 0, toDo: 2 },
			collapsible: false
		}
	],
	total: 3
};

const noop = () => {};

describe('TimelineList', () => {
	it('renders one section per phase, in order, with a scroll-target id', () => {
		const { container } = render(TimelineList, {
			props: { view: VIEW, onSetStatus: noop, onSetSnooze: noop }
		});
		const ids = [...container.querySelectorAll('section')].map((s) => s.id);
		expect(ids).toEqual(['phase-18-12', 'phase-final-90']); // one section per phase, in order (ids are count-free)
		expect(container.querySelector('section#phase-18-12')).not.toBeNull();
		expect(container.querySelector('section#phase-final-90')).not.toBeNull();
	});

	it('labels each section by its heading (aria-labelledby) for landmark navigation', () => {
		const { container } = render(TimelineList, {
			props: { view: VIEW, onSetStatus: noop, onSetSnooze: noop }
		});
		const section = container.querySelector('section#phase-18-12');
		const labelledby = section?.getAttribute('aria-labelledby');
		expect(labelledby).toBeTruthy();
		expect(container.querySelector(`#${labelledby}`)?.textContent).toContain('18-12 months out'); // heading now also carries the progress count (C4-4)
	});

	it('renders a TaskCard per item across all phases', () => {
		const { container } = render(TimelineList, {
			props: { view: VIEW, onSetStatus: noop, onSetSnooze: noop }
		});
		expect(container.querySelectorAll('article.task-card').length).toBe(3);
		expect(container.textContent).toContain('Request medical records');
		expect(container.textContent).toContain('File VA intent-to-file');
		expect(container.textContent).toContain('DD-214 review');
	});
});

describe('TimelineList phase progress counts (C4-4 B1)', () => {
	it('active phase header shows the "N to do" count (Format 1)', () => {
		const { container } = render(TimelineList, {
			props: { view: VIEW, onSetStatus: noop, onSetSnooze: noop }
		});
		const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent);
		expect(headings[0]).toContain('1 to do'); // phase-18-12: 1 active task
		expect(headings[1]).toContain('2 to do'); // phase-final-90: 2 active tasks
	});

	it('resolved phase header shows the done/skipped breakdown', () => {
		const resolvedView: TimelineView = {
			phases: [
				{
					bucket: { id: 'phase-x', label: '18-12 months out', startOffset: -540, endOffset: -360 },
					items: [
						makeItem('A', 'done'),
						makeItem('B', 'done'),
						makeItem('C', 'done'),
						makeItem('D', 'skipped')
					],
					count: 4,
					counts: { done: 3, skipped: 1, snoozed: 0, toDo: 0 },
					collapsible: true
				}
			],
			total: 4
		};
		const { container } = render(TimelineList, {
			props: { view: resolvedView, onSetStatus: noop, onSetSnooze: noop }
		});
		const heading = container.querySelector('h2')?.textContent;
		expect(heading).toContain('3 done');
		expect(heading).toContain('1 skipped');
	});

	it('counts snoozed tasks as "to do" (snoozed is paused, not done)', () => {
		const view: TimelineView = {
			phases: [
				{
					bucket: { id: 'phase-y', label: '12-6 months out', startOffset: -360, endOffset: -180 },
					items: [makeItem('A', 'overdue'), makeItem('B', 'snoozed'), makeItem('C', 'done')],
					count: 3,
					counts: { done: 1, skipped: 0, snoozed: 1, toDo: 1 },
					collapsible: false
				}
			],
			total: 3
		};
		const { container } = render(TimelineList, {
			props: { view, onSetStatus: noop, onSetSnooze: noop }
		});
		expect(container.querySelector('h2')?.textContent).toContain('2 to do'); // 1 active + 1 snoozed
	});
});

describe('TimelineList section auto-collapse (C4-4 B2)', () => {
	const resolvedView: TimelineView = {
		phases: [
			{
				bucket: { id: 'phase-x', label: '18-12 months out', startOffset: -540, endOffset: -360 },
				items: [
					makeItem('Request medical records', 'done'),
					makeItem('Separation physical', 'skipped')
				],
				count: 2,
				counts: { done: 1, skipped: 1, snoozed: 0, toDo: 0 },
				collapsible: true
			}
		],
		total: 2
	};

	it('collapses a fully-resolved phase by default (disclosure button, cards hidden)', () => {
		const { container } = render(TimelineList, {
			props: { view: resolvedView, onSetStatus: noop, onSetSnooze: noop }
		});
		const toggle = container.querySelector('button.timeline-list__toggle');
		expect(toggle?.getAttribute('aria-expanded')).toBe('false');
		expect(container.textContent).not.toContain('Request medical records'); // cards hidden until expanded
	});

	it('expands a collapsed phase on tap (cards shown)', () => {
		const { container } = render(TimelineList, {
			props: { view: resolvedView, onSetStatus: noop, onSetSnooze: noop }
		});
		(container.querySelector('button.timeline-list__toggle') as HTMLButtonElement | null)?.click();
		flushSync();
		expect(
			container.querySelector('button.timeline-list__toggle')?.getAttribute('aria-expanded')
		).toBe('true');
		expect(container.textContent).toContain('Request medical records');
	});

	it('an active phase has no disclosure (no caret/tap), cards shown directly', () => {
		const { container } = render(TimelineList, {
			props: { view: VIEW, onSetStatus: noop, onSetSnooze: noop }
		});
		expect(container.querySelector('button.timeline-list__toggle')).toBeNull();
		expect(container.textContent).toContain('Request medical records');
	});

	it('auto-collapses a phase that becomes resolved again (no stale expand after restore)', () => {
		const props = $state<{
			view: TimelineView;
			onSetStatus: (taskId: string, status: TaskStatus | undefined) => void;
			onSetSnooze: (taskId: string, untilIso: string) => void;
		}>({ view: resolvedView, onSetStatus: noop, onSetSnooze: noop });
		const { container } = render(TimelineList, { props });
		const toggle = () => container.querySelector('button.timeline-list__toggle');

		// User expands the collapsed phase.
		(toggle() as HTMLButtonElement | null)?.click();
		flushSync();
		expect(toggle()?.getAttribute('aria-expanded')).toBe('true');

		// A task is restored -> the phase is no longer collapsible (renders open, no toggle).
		props.view = {
			phases: [
				{
					bucket: { id: 'phase-x', label: '18-12 months out', startOffset: -540, endOffset: -360 },
					items: [
						makeItem('Request medical records', 'overdue'),
						makeItem('Separation physical', 'skipped')
					],
					count: 2,
					counts: { done: 0, skipped: 1, snoozed: 0, toDo: 1 },
					collapsible: false
				}
			],
			total: 2
		};
		flushSync();
		expect(toggle()).toBeNull();

		// Re-resolved -> collapsible again -> must auto-collapse, NOT reopen stale-expanded.
		props.view = resolvedView;
		flushSync();
		expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
		expect(container.textContent).not.toContain('Request medical records'); // collapsed = cards hidden
	});
});
