import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import TimelineList from './TimelineList.svelte';
import type { TimelineView, TimelineItem, DisplayStatus } from '$lib/timeline';

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
			count: 1
		},
		{
			bucket: { id: 'phase-final-90', label: 'Final 90 days', startOffset: -90, endOffset: 0 },
			items: [makeItem('File VA intent-to-file', 'overdue'), makeItem('DD-214 review')],
			count: 2
		}
	],
	total: 3
};

const noop = () => {};

describe('TimelineList', () => {
	it('renders one section per phase, in order, with a scroll-target id', () => {
		const { container } = render(TimelineList, { props: { view: VIEW, onSetStatus: noop } });
		const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent);
		expect(headings).toEqual(['18-12 months out', 'Final 90 days']);
		expect(container.querySelector('section#phase-18-12')).not.toBeNull();
		expect(container.querySelector('section#phase-final-90')).not.toBeNull();
	});

	it('labels each section by its heading (aria-labelledby) for landmark navigation', () => {
		const { container } = render(TimelineList, { props: { view: VIEW, onSetStatus: noop } });
		const section = container.querySelector('section#phase-18-12');
		const labelledby = section?.getAttribute('aria-labelledby');
		expect(labelledby).toBeTruthy();
		expect(container.querySelector(`#${labelledby}`)?.textContent).toBe('18-12 months out');
	});

	it('renders a TaskCard per item across all phases', () => {
		const { container } = render(TimelineList, { props: { view: VIEW, onSetStatus: noop } });
		expect(container.querySelectorAll('article.task-card').length).toBe(3);
		expect(container.textContent).toContain('Request medical records');
		expect(container.textContent).toContain('File VA intent-to-file');
		expect(container.textContent).toContain('DD-214 review');
	});
});
