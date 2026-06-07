import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import TaskCard from './TaskCard.svelte';
import type { TimelineItem, TaskDef } from '$lib/timeline';

// TaskCard renders one generated TimelineItem as an open status card (C3): status-color left
// edge + text status label (never color-only) + a status-specific date line + category chip +
// why. Open states only (Upcoming / Start now / Overdue); resolved-state collapse is C4.

const DEF: TaskDef = {
	id: 'skillbridge-hosts',
	title: 'Research SkillBridge hosts',
	category: 'career',
	track: 'transition',
	windowStart: -540,
	windowEnd: -365,
	why: 'Find approved programs that fit your rate.',
	value: 'A concrete shortlist before the window opens.'
};

function makeItem(overrides: Partial<TimelineItem> = {}): TimelineItem {
	return {
		def: DEF,
		targetDate: '2026-10-15',
		windowStartDate: '2025-10-23',
		windowEndDate: '2026-04-15',
		status: 'upcoming',
		...overrides
	};
}

describe('TaskCard (open states)', () => {
	it('renders the title, category chip, and why', () => {
		const { container } = render(TaskCard, { props: { item: makeItem() } });
		expect(container.textContent).toContain('Research SkillBridge hosts');
		expect(container.textContent).toContain('Career'); // category label, capitalized
		expect(container.textContent).toContain('Find approved programs that fit your rate.');
	});

	it('upcoming: status-color edge class + "Upcoming" label + the target date', () => {
		const { container } = render(TaskCard, {
			props: { item: makeItem({ status: 'upcoming', targetDate: '2027-03-16' }) }
		});
		const card = container.querySelector('article');
		expect(card?.classList.contains('status-upcoming')).toBe(true);
		expect(container.textContent).toContain('Upcoming'); // text label, never color-only
		expect(container.textContent).toContain('Mar 16, 2027');
	});

	it('start-now: edge class + "Start now" + "Window to <end>"', () => {
		const { container } = render(TaskCard, {
			props: { item: makeItem({ status: 'start-now', windowEndDate: '2026-10-15' }) }
		});
		const card = container.querySelector('article');
		expect(card?.classList.contains('status-start-now')).toBe(true);
		expect(container.textContent).toContain('Start now');
		expect(container.textContent).toContain('Window to Oct 15, 2026');
	});

	it('overdue: edge class + "Overdue" + "since <end>"', () => {
		const { container } = render(TaskCard, {
			props: { item: makeItem({ status: 'overdue', windowEndDate: '2027-01-15' }) }
		});
		const card = container.querySelector('article');
		expect(card?.classList.contains('status-overdue')).toBe(true);
		expect(container.textContent).toContain('Overdue');
		expect(container.textContent).toContain('since Jan 15, 2027');
	});

	it('color-codes the category chip via a category-<name> class (text label still present)', () => {
		const career = render(TaskCard, { props: { item: makeItem() } });
		const careerChip = career.container.querySelector('.task-card__chip');
		expect(careerChip?.classList.contains('category-career')).toBe(true);
		expect(careerChip?.textContent).toBe('Career'); // color is an aid; the label still carries it

		const medical = render(TaskCard, {
			props: { item: makeItem({ def: { ...DEF, category: 'medical' } }) }
		});
		expect(
			medical.container.querySelector('.task-card__chip')?.classList.contains('category-medical')
		).toBe(true);
	});
});
