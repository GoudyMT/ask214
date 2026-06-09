import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import PhaseChips from './PhaseChips.svelte';
import type { TimelineView, TimelineItem } from '$lib/timeline';

// PhaseChips is the C5 jump-nav: one chip per non-empty phase (short label + total task count),
// clicking a chip smooth-scrolls to that phase's <section id> (jump, NOT filter), and a toggle
// collapses the strip. Scroll-spy (IntersectionObserver active-state) is covered by the Arc D E2E,
// not here - a component test can't drive the viewport deterministically.

function makeItem(title: string): TimelineItem {
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
		status: 'upcoming'
	};
}

const VIEW: TimelineView = {
	phases: [
		{
			bucket: {
				id: 'phase-18-12',
				label: '18-12 months out',
				shortLabel: '18-12 mo',
				startOffset: -540,
				endOffset: -360
			},
			items: [makeItem('A'), makeItem('B'), makeItem('C')],
			count: 3,
			counts: { done: 0, skipped: 0, snoozed: 0, toDo: 3 },
			collapsible: false
		},
		{
			bucket: {
				id: 'phase-final-90',
				label: 'Final 90 days',
				shortLabel: 'Final 90',
				startOffset: -90,
				endOffset: 0
			},
			items: [makeItem('D')],
			count: 1,
			counts: { done: 0, skipped: 0, snoozed: 0, toDo: 1 },
			collapsible: false
		}
	],
	total: 4
};

describe('PhaseChips', () => {
	it('renders a chip per phase with its short label and total task count, in order', () => {
		const { container } = render(PhaseChips, { props: { view: VIEW } });
		const chips = [...container.querySelectorAll('button.phase-chips__chip')];
		expect(chips.length).toBe(2);
		expect(chips[0]?.textContent).toContain('18-12 mo');
		expect(chips[0]?.textContent).toContain('3'); // 3 tasks in this phase
		expect(chips[1]?.textContent).toContain('Final 90');
		expect(chips[1]?.textContent).toContain('1'); // 1 task
	});

	it('falls back to the full label when a bucket has no short label', () => {
		const view: TimelineView = {
			phases: [
				{
					bucket: { id: 'p', label: 'After separation', startOffset: 0, endOffset: 730 },
					items: [makeItem('A')],
					count: 1,
					counts: { done: 0, skipped: 0, snoozed: 0, toDo: 1 },
					collapsible: false
				}
			],
			total: 1
		};
		const { container } = render(PhaseChips, { props: { view } });
		expect(container.querySelector('button.phase-chips__chip')?.textContent).toContain(
			'After separation'
		);
	});

	it('smooth-scrolls to a phase section when its chip is clicked', () => {
		// The <section id> lives in TimelineList (a sibling in the page); PhaseChips reaches it by id.
		const section = document.createElement('section');
		section.id = 'phase-final-90';
		document.body.appendChild(section);
		const scrollSpy = vi.spyOn(section, 'scrollIntoView').mockImplementation(() => {});

		const { container } = render(PhaseChips, { props: { view: VIEW } });
		const finalChip = [...container.querySelectorAll('button.phase-chips__chip')].find((c) =>
			c.textContent?.includes('Final 90')
		) as HTMLButtonElement;
		finalChip.click();
		flushSync();

		expect(scrollSpy).toHaveBeenCalled();
		section.remove();
	});

	it('collapses and expands the strip via the toggle', () => {
		const { container } = render(PhaseChips, { props: { view: VIEW } });
		const toggle = container.querySelector('button.phase-chips__toggle') as HTMLButtonElement;
		expect(toggle.getAttribute('aria-expanded')).toBe('true'); // expanded by default
		expect(container.querySelectorAll('button.phase-chips__chip').length).toBe(2);

		toggle.click();
		flushSync();
		expect(
			container.querySelector('button.phase-chips__toggle')?.getAttribute('aria-expanded')
		).toBe('false');
		expect(container.querySelectorAll('button.phase-chips__chip').length).toBe(0); // strip hidden
	});
});
