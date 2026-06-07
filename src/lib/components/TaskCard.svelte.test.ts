import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import TaskCard from './TaskCard.svelte';
import { snoozeUntilIso } from '$lib/timeline/snooze';
import type { TimelineItem, TaskDef, TaskStatus } from '$lib/timeline';

// TaskCard renders one generated TimelineItem as an open status card (C3): status-color left
// edge + text status label (never color-only) + a status-specific date line + category chip +
// why. C4 adds the action row: Mark done / Skip (increment 1) + Snooze (increment 2).

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

const noop = () => {};

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

function renderCard(
	item: TimelineItem,
	handlers: {
		onSetStatus?: (taskId: string, status: TaskStatus | undefined) => void;
		onSetSnooze?: (taskId: string, untilIso: string) => void;
	} = {}
) {
	return render(TaskCard, {
		props: {
			item,
			onSetStatus: handlers.onSetStatus ?? noop,
			onSetSnooze: handlers.onSetSnooze ?? noop
		}
	});
}

function buttonByText(container: Element, text: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

describe('TaskCard (open states)', () => {
	it('renders the title, category chip, and why', () => {
		const { container } = renderCard(makeItem());
		expect(container.textContent).toContain('Research SkillBridge hosts');
		expect(container.textContent).toContain('Career'); // category label, capitalized
		expect(container.textContent).toContain('Find approved programs that fit your rate.');
	});

	it('upcoming: status-color edge class + "Upcoming" label + the target date', () => {
		const { container } = renderCard(makeItem({ status: 'upcoming', targetDate: '2027-03-16' }));
		const card = container.querySelector('article');
		expect(card?.classList.contains('status-upcoming')).toBe(true);
		expect(container.textContent).toContain('Upcoming'); // text label, never color-only
		expect(container.textContent).toContain('Mar 16, 2027');
	});

	it('start-now: edge class + "Start now" + "Window to <end>"', () => {
		const { container } = renderCard(
			makeItem({ status: 'start-now', windowEndDate: '2026-10-15' })
		);
		const card = container.querySelector('article');
		expect(card?.classList.contains('status-start-now')).toBe(true);
		expect(container.textContent).toContain('Start now');
		expect(container.textContent).toContain('Window to Oct 15, 2026');
	});

	it('overdue: edge class + "Overdue" + "since <end>"', () => {
		const { container } = renderCard(makeItem({ status: 'overdue', windowEndDate: '2027-01-15' }));
		const card = container.querySelector('article');
		expect(card?.classList.contains('status-overdue')).toBe(true);
		expect(container.textContent).toContain('Overdue');
		expect(container.textContent).toContain('since Jan 15, 2027');
	});

	it('color-codes the category chip via a category-<name> class (text label still present)', () => {
		const career = renderCard(makeItem());
		const careerChip = career.container.querySelector('.task-card__chip');
		expect(careerChip?.classList.contains('category-career')).toBe(true);
		expect(careerChip?.textContent).toBe('Career'); // color is an aid; the label still carries it

		const medical = renderCard(makeItem({ def: { ...DEF, category: 'medical' } }));
		expect(
			medical.container.querySelector('.task-card__chip')?.classList.contains('category-medical')
		).toBe(true);
	});

	it('renders Mark done, Skip, and Snooze actions on an open card', () => {
		const { container } = renderCard(makeItem());
		expect(buttonByText(container, 'Mark done')).toBeDefined();
		expect(buttonByText(container, 'Skip')).toBeDefined();
		expect(buttonByText(container, 'Snooze')).toBeDefined();
	});

	it('Mark done calls onSetStatus(id, "done")', () => {
		const onSetStatus = vi.fn();
		const { container } = renderCard(makeItem(), { onSetStatus });
		buttonByText(container, 'Mark done')?.click();
		expect(onSetStatus).toHaveBeenCalledWith('skillbridge-hosts', 'done');
	});

	it('Skip calls onSetStatus(id, "skipped")', () => {
		const onSetStatus = vi.fn();
		const { container } = renderCard(makeItem(), { onSetStatus });
		buttonByText(container, 'Skip')?.click();
		expect(onSetStatus).toHaveBeenCalledWith('skillbridge-hosts', 'skipped');
	});

	it('Snooze opens a picker with presets and a pick-a-date option', () => {
		const { container } = renderCard(makeItem());
		buttonByText(container, 'Snooze')?.click();
		flushSync();
		expect(buttonByText(container, '1 week')).toBeDefined();
		expect(buttonByText(container, '1 month')).toBeDefined();
		expect(buttonByText(container, '3 months')).toBeDefined();
		expect(buttonByText(container, 'Pick a date...')).toBeDefined();
	});

	it('a snooze preset calls onSetSnooze with the computed ISO date', () => {
		const onSetSnooze = vi.fn();
		const { container } = renderCard(makeItem(), { onSetSnooze });
		buttonByText(container, 'Snooze')?.click();
		flushSync();
		buttonByText(container, '1 week')?.click();
		expect(onSetSnooze).toHaveBeenCalledWith('skillbridge-hosts', snoozeUntilIso(new Date(), 7));
	});

	it('Pick a date reveals a date input; confirming calls onSetSnooze with that date', () => {
		const onSetSnooze = vi.fn();
		const { container } = renderCard(makeItem(), { onSetSnooze });
		buttonByText(container, 'Snooze')?.click();
		flushSync();
		buttonByText(container, 'Pick a date...')?.click();
		flushSync();
		const input = container.querySelector('input[type="date"]') as HTMLInputElement | null;
		if (!input) throw new Error('no date input rendered');
		input.value = '2026-08-01';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		const confirm = container.querySelector(
			'.task-card__date-row button'
		) as HTMLButtonElement | null;
		confirm?.click();
		expect(onSetSnooze).toHaveBeenCalledWith('skillbridge-hosts', '2026-08-01');
	});
});
