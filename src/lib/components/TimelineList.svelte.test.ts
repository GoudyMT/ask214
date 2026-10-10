import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import { flushSync } from 'svelte';
import TimelineList from './TimelineList.svelte';
import type { TimelineView, TimelineItem, DisplayStatus, TaskStatus } from '$lib/timeline';

// TimelineList renders a generated TimelineView: one labelled <section> per non-empty
// phase (h2 = bucket.label, id = bucket.id to seed scroll-spy), each holding a TaskCard per
// item. Empty/locked/no-EAOS states are handled by the route, not here.

function makeItem(title: string, status: DisplayStatus = 'upcoming'): TimelineItem {
	return {
		def: {
			id: title.toLowerCase().replace(/[^a-z]+/g, '-'),
			title,
			category: 'admin',
			finishBefore: 'separation',
			kind: 'soft',
			windowStart: -120,
			windowEnd: -60,
			why: `Why ${title} matters.`
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
			counts: { done: 0, skipped: 0, snoozed: 0, toDo: 1, closed: 0 },
			collapsible: false
		},
		{
			bucket: { id: 'phase-final-90', label: 'Final 90 days', startOffset: -90, endOffset: 0 },
			items: [makeItem('File VA intent-to-file', 'late'), makeItem('DD-214 review')],
			count: 2,
			counts: { done: 0, skipped: 0, snoozed: 0, toDo: 2, closed: 0 },
			collapsible: false
		}
	],
	total: 3
};

const noop = () => {};

describe('TimelineList', () => {
	it('renders one section per phase, in order, with a scroll-target id', async () => {
		const { container } = await render(TimelineList, {
			props: { view: VIEW, onSetStatus: noop, onSetSnooze: noop }
		});
		const ids = [...container.querySelectorAll('section')].map((s) => s.id);
		expect(ids).toEqual(['phase-18-12', 'phase-final-90']); // one section per phase, in order (ids are count-free)
		expect(container.querySelector('section#phase-18-12')).not.toBeNull();
		expect(container.querySelector('section#phase-final-90')).not.toBeNull();
	});

	it('labels each section by its heading (aria-labelledby) for landmark navigation', async () => {
		const { container } = await render(TimelineList, {
			props: { view: VIEW, onSetStatus: noop, onSetSnooze: noop }
		});
		const section = container.querySelector('section#phase-18-12');
		const labelledby = section?.getAttribute('aria-labelledby');
		expect(labelledby).toBeTruthy();
		expect(container.querySelector(`#${labelledby}`)?.textContent).toContain('18-12 months out'); // heading now also carries the progress count
	});

	it('renders a TaskCard per item across all phases', async () => {
		const { container } = await render(TimelineList, {
			props: { view: VIEW, onSetStatus: noop, onSetSnooze: noop }
		});
		expect(container.querySelectorAll('article.task-card').length).toBe(3);
		expect(container.textContent).toContain('Request medical records');
		expect(container.textContent).toContain('File VA intent-to-file');
		expect(container.textContent).toContain('DD-214 review');
	});
});

// Each count's number and words are joined by non-breaking spaces, so a header wraps only at its " - " separators.
const NBSP = String.fromCharCode(160);

describe('TimelineList phase progress counts', () => {
	it('active phase header shows the "N to do" count (Format 1)', async () => {
		const { container } = await render(TimelineList, {
			props: { view: VIEW, onSetStatus: noop, onSetSnooze: noop }
		});
		const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent);
		expect(headings[0]).toContain(`1${NBSP}to${NBSP}do`); // phase-18-12: 1 active task
		expect(headings[1]).toContain(`2${NBSP}to${NBSP}do`); // phase-final-90: 2 active tasks
	});

	it('resolved phase header shows the done/skipped breakdown', async () => {
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
					counts: { done: 3, skipped: 1, snoozed: 0, toDo: 0, closed: 0 },
					collapsible: true
				}
			],
			total: 4
		};
		const { container } = await render(TimelineList, {
			props: { view: resolvedView, onSetStatus: noop, onSetSnooze: noop }
		});
		const heading = container.querySelector('h2')?.textContent;
		expect(heading).toContain(`3${NBSP}done`);
		expect(heading).toContain(`1${NBSP}skipped`);
	});

	it('counts snoozed tasks as "to do" (snoozed is paused, not done)', async () => {
		const view: TimelineView = {
			phases: [
				{
					bucket: { id: 'phase-y', label: '12-6 months out', startOffset: -360, endOffset: -180 },
					items: [makeItem('A', 'late'), makeItem('B', 'snoozed'), makeItem('C', 'done')],
					count: 3,
					counts: { done: 1, skipped: 0, snoozed: 1, toDo: 1, closed: 0 },
					collapsible: false
				}
			],
			total: 3
		};
		const { container } = await render(TimelineList, {
			props: { view, onSetStatus: noop, onSetSnooze: noop }
		});
		expect(container.querySelector('h2')?.textContent).toContain(`2${NBSP}to${NBSP}do`); // 1 active + 1 snoozed
	});

	// A closed task can no longer be done, so the count says so apart from what is left to do.
	describe('closed tasks in the header count', () => {
		const countOf = async (
			counts: { done: number; skipped: number; toDo: number; closed: number },
			collapsible: boolean
		) => {
			// A task's id is made of the letters of its title, so each title differs in its letters.
			const letter = (n: number) => String.fromCharCode(97 + n);
			const items = [
				...Array.from({ length: counts.done }, (_, n) => makeItem(`Done ${letter(n)}`, 'done')),
				...Array.from({ length: counts.skipped }, (_, n) =>
					makeItem(`Skipped ${letter(n)}`, 'skipped')
				),
				...Array.from({ length: counts.toDo }, (_, n) => makeItem(`Open ${letter(n)}`, 'late')),
				...Array.from({ length: counts.closed }, (_, n) =>
					makeItem(`Closed ${letter(n)}`, 'closed')
				)
			];
			const view: TimelineView = {
				phases: [
					{
						bucket: { id: 'phase-z', label: '6-3 months out', startOffset: -180, endOffset: -90 },
						items,
						count: items.length,
						counts: { ...counts, snoozed: 0 },
						collapsible
					}
				],
				total: items.length
			};
			const { container } = await render(TimelineList, {
				props: { view, onSetStatus: noop, onSetSnooze: noop }
			});
			return container.querySelector('h2 .timeline-list__count')?.textContent;
		};

		it('an open phase says what is left to do and what closed', async () => {
			expect(await countOf({ done: 3, skipped: 0, toDo: 2, closed: 5 }, false)).toBe(
				`- 2${NBSP}to${NBSP}do - 5${NBSP}closed`
			);
		});

		it('an open phase with only a just-closed task left says only that', async () => {
			expect(await countOf({ done: 1, skipped: 0, toDo: 0, closed: 1 }, false)).toBe(
				`- 1${NBSP}closed`
			);
		});

		it('a folded phase says what was done, skipped and closed', async () => {
			expect(await countOf({ done: 5, skipped: 0, toDo: 0, closed: 5 }, true)).toBe(
				`- 5${NBSP}done - 5${NBSP}closed`
			);
			expect(await countOf({ done: 2, skipped: 1, toDo: 0, closed: 1 }, true)).toBe(
				`- 2${NBSP}done - 1${NBSP}skipped - 1${NBSP}closed`
			);
		});

		// A whitespace-folding matcher reads a non-breaking space as a space, so the character itself is checked here.
		it('keeps each count whole: a line can break only at the separators', async () => {
			for (const [counts, collapsible] of [
				[{ done: 0, skipped: 0, toDo: 2, closed: 5 }, false],
				[{ done: 2, skipped: 1, toDo: 0, closed: 1 }, true]
			] as const) {
				const parts = (await countOf(counts, collapsible))?.slice(2).split(' - ') ?? [];
				expect(parts.length).toBeGreaterThan(1);
				for (const part of parts) {
					expect(part).not.toContain(' ');
					const [count, ...words] = part.split(NBSP);
					expect(Number(count)).toBeGreaterThan(0);
					expect(words.length).toBeGreaterThan(0);
				}
			}
		});
	});
});

// A button sets its own case and letter spacing, so a folded phase's label could read unlike the open headings.
it('a folded phase label has the case and letter spacing of an open phase heading', async () => {
	const phase = (id: string, collapsible: boolean, status: DisplayStatus) => ({
		bucket: { id, label: `${id} months out`, startOffset: -540, endOffset: -360 },
		items: [makeItem(`Task ${id}`, status)],
		count: 1,
		counts: {
			done: status === 'done' ? 1 : 0,
			skipped: 0,
			snoozed: 0,
			toDo: status === 'done' ? 0 : 1,
			closed: 0
		},
		collapsible
	});
	const view: TimelineView = {
		phases: [phase('folded', true, 'done'), phase('open', false, 'late')],
		total: 2
	};
	const { container } = await render(TimelineList, {
		props: { view, onSetStatus: noop, onSetSnooze: noop }
	});
	const toggle = container.querySelector('button.timeline-list__toggle');
	const openHeading = container.querySelector('#open-heading');
	if (!toggle || !openHeading) throw new Error('no folded toggle or open heading rendered');
	const folded = getComputedStyle(toggle);
	const open = getComputedStyle(openHeading);
	expect(open.textTransform).toBe('uppercase');
	expect(folded.textTransform).toBe(open.textTransform);
	expect(folded.letterSpacing).toBe(open.letterSpacing);
});

describe('TimelineList section auto-collapse', () => {
	const resolvedView: TimelineView = {
		phases: [
			{
				bucket: { id: 'phase-x', label: '18-12 months out', startOffset: -540, endOffset: -360 },
				items: [
					makeItem('Request medical records', 'done'),
					makeItem('Separation physical', 'skipped')
				],
				count: 2,
				counts: { done: 1, skipped: 1, snoozed: 0, toDo: 0, closed: 0 },
				collapsible: true
			}
		],
		total: 2
	};

	it('collapses a fully-resolved phase by default (disclosure button, cards hidden)', async () => {
		const { container } = await render(TimelineList, {
			props: { view: resolvedView, onSetStatus: noop, onSetSnooze: noop }
		});
		const toggle = container.querySelector('button.timeline-list__toggle');
		expect(toggle?.getAttribute('aria-expanded')).toBe('false');
		expect(container.textContent).not.toContain('Request medical records'); // cards hidden until expanded
	});

	it('expands a collapsed phase on tap (cards shown)', async () => {
		const { container } = await render(TimelineList, {
			props: { view: resolvedView, onSetStatus: noop, onSetSnooze: noop }
		});
		(container.querySelector('button.timeline-list__toggle') as HTMLButtonElement | null)?.click();
		flushSync();
		expect(
			container.querySelector('button.timeline-list__toggle')?.getAttribute('aria-expanded')
		).toBe('true');
		expect(container.textContent).toContain('Request medical records');
	});

	it('an active phase has no disclosure (no caret/tap), cards shown directly', async () => {
		const { container } = await render(TimelineList, {
			props: { view: VIEW, onSetStatus: noop, onSetSnooze: noop }
		});
		expect(container.querySelector('button.timeline-list__toggle')).toBeNull();
		expect(container.textContent).toContain('Request medical records');
	});

	it('auto-collapses a phase that becomes resolved again (no stale expand after restore)', async () => {
		const props = $state<{
			view: TimelineView;
			onSetStatus: (taskId: string, status: TaskStatus | undefined) => void;
			onSetSnooze: (taskId: string, untilIso: string) => void;
		}>({ view: resolvedView, onSetStatus: noop, onSetSnooze: noop });
		const { container } = await render(TimelineList, { props });
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
						makeItem('Request medical records', 'late'),
						makeItem('Separation physical', 'skipped')
					],
					count: 2,
					counts: { done: 0, skipped: 1, snoozed: 0, toDo: 1, closed: 0 },
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

describe('TimelineList Today marker', () => {
	it('renders the Today marker before the phase at todayMarkerIndex', async () => {
		const view: TimelineView = { ...VIEW, todayMarkerIndex: 1, todayDate: '2026-06-09' };
		const { container } = await render(TimelineList, {
			props: { view, onSetStatus: noop, onSetSnooze: noop }
		});
		const marker = container.querySelector('.timeline-today');
		expect(marker).not.toBeNull();
		expect(marker?.textContent).toContain('Today');
		expect(marker?.textContent).toContain('Jun 9, 2026'); // formatTimelineDate(todayDate)

		// Position: the marker sits between section[0] (phase-18-12) and section[1] (phase-final-90).
		const kids = [...(container.querySelector('.timeline-list')?.children ?? [])];
		const markerIdx = kids.findIndex((el) => el.classList.contains('timeline-today'));
		const sec0Idx = kids.findIndex((el) => el.id === 'phase-18-12');
		const sec1Idx = kids.findIndex((el) => el.id === 'phase-final-90');
		expect(sec0Idx).toBeLessThan(markerIdx);
		expect(markerIdx).toBeLessThan(sec1Idx);
	});

	it('renders no Today marker when todayMarkerIndex is absent', async () => {
		const { container } = await render(TimelineList, {
			props: { view: VIEW, onSetStatus: noop, onSetSnooze: noop }
		});
		expect(container.querySelector('.timeline-today')).toBeNull();
	});

	it('shows the days-left count by the marker when separation is in the future', async () => {
		const view: TimelineView = {
			...VIEW,
			todayMarkerIndex: 1,
			todayDate: '2026-06-09',
			daysToSeparation: 100
		};
		const { container } = await render(TimelineList, {
			props: { view, onSetStatus: noop, onSetSnooze: noop }
		});
		expect(container.querySelector('.timeline-today')?.textContent).toContain('100 days left');
	});

	it('hides the days-left count once separation has passed', async () => {
		const view: TimelineView = {
			...VIEW,
			todayMarkerIndex: 2,
			todayDate: '2027-05-01',
			daysToSeparation: 0
		};
		const { container } = await render(TimelineList, {
			props: { view, onSetStatus: noop, onSetSnooze: noop }
		});
		expect(container.querySelector('.timeline-today')?.textContent).not.toContain('days left');
	});
});
