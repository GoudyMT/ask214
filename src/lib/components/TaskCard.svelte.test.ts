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
		onSetNote?: (taskId: string, note: string | undefined) => void;
	} = {}
) {
	return render(TaskCard, {
		props: {
			item,
			onSetStatus: handlers.onSetStatus ?? noop,
			onSetSnooze: handlers.onSetSnooze ?? noop,
			onSetNote: handlers.onSetNote ?? noop
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
		expect(buttonByText(container, 'Customize')).toBeDefined();
	});

	it('a snooze preset calls onSetSnooze with the computed ISO date', () => {
		const onSetSnooze = vi.fn();
		const { container } = renderCard(makeItem(), { onSetSnooze });
		buttonByText(container, 'Snooze')?.click();
		flushSync();
		buttonByText(container, '1 week')?.click();
		expect(onSetSnooze).toHaveBeenCalledWith('skillbridge-hosts', snoozeUntilIso(new Date(), 7));
	});

	it('Customize reveals a date input; confirming calls onSetSnooze with that date', () => {
		const onSetSnooze = vi.fn();
		const { container } = renderCard(makeItem(), { onSetSnooze });
		buttonByText(container, 'Snooze')?.click();
		flushSync();
		buttonByText(container, 'Customize')?.click();
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

	it('Add note reveals a textarea; Save calls onSetNote with the text', () => {
		const onSetNote = vi.fn();
		const { container } = renderCard(makeItem(), { onSetNote });
		buttonByText(container, 'Add note')?.click();
		flushSync();
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
		if (!textarea) throw new Error('no note textarea rendered');
		textarea.value = 'Call the VSO Monday';
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		buttonByText(container, 'Save')?.click();
		expect(onSetNote).toHaveBeenCalledWith('skillbridge-hosts', 'Call the VSO Monday');
	});

	it('Cancel closes the note editor without saving', () => {
		const onSetNote = vi.fn();
		const { container } = renderCard(makeItem(), { onSetNote });
		buttonByText(container, 'Add note')?.click();
		flushSync();
		buttonByText(container, 'Cancel')?.click();
		flushSync();
		expect(onSetNote).not.toHaveBeenCalled();
		expect(container.querySelector('textarea')).toBeNull();
	});
});

// C4 increment 3: resolved tasks (done/skipped/snoozed) collapse to a one-line disclosure
// (decision A: snoozed shows "to <date>"; done/skipped show no date). Tapping expands to the
// full card with a unified Restore action (decision B: onSetStatus(id, undefined)). Open states
// are unchanged. Collapse state is ephemeral local $state.
describe('TaskCard (resolved / collapsed states)', () => {
	function lineButton(container: Element): HTMLButtonElement | null {
		return container.querySelector('button.task-line');
	}

	it('done: collapses to a disclosure line (aria-expanded=false), no date, why hidden', () => {
		const { container } = renderCard(makeItem({ status: 'done' }));
		const line = lineButton(container);
		expect(line).not.toBeNull();
		expect(line?.getAttribute('aria-expanded')).toBe('false');
		expect(line?.textContent).toContain('Research SkillBridge hosts');
		expect(line?.textContent).toContain('Done');
		expect(container.querySelector('.task-line__date')).toBeNull(); // decision A: no date for done
		expect(container.textContent).not.toContain('Find approved programs that fit your rate.');
	});

	it('snoozed: collapsed line shows "Snoozed" + "to <date>" (decision A)', () => {
		const { container } = renderCard(makeItem({ status: 'snoozed', snoozeUntil: '2026-08-01' }));
		expect(lineButton(container)?.textContent).toContain('Snoozed');
		expect(container.querySelector('.task-line__date')?.textContent).toContain('to Aug 1, 2026');
	});

	it('skipped: collapsed line shows "Skipped" + no date (decision A)', () => {
		const { container } = renderCard(makeItem({ status: 'skipped' }));
		expect(lineButton(container)?.textContent).toContain('Skipped');
		expect(container.querySelector('.task-line__date')).toBeNull();
	});

	it('expanding a resolved task reveals the full card + a Restore action', () => {
		const { container } = renderCard(makeItem({ status: 'done' }));
		lineButton(container)?.click();
		flushSync();
		expect(container.textContent).toContain('Find approved programs that fit your rate.');
		expect(buttonByText(container, 'Restore')).toBeDefined();
		expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
	});

	it('the expanded collapse control is the header row (contains the title), not a bare caret', () => {
		const { container } = renderCard(makeItem({ status: 'done' }));
		(container.querySelector('button.task-line') as HTMLButtonElement | null)?.click();
		flushSync();
		const toggle = container.querySelector('button[aria-expanded="true"]');
		expect(toggle?.textContent).toContain('Research SkillBridge hosts'); // tap the whole header, not a caret
	});

	it('Restore clears the status via onSetStatus(id, undefined) (decision B)', () => {
		const onSetStatus = vi.fn();
		const { container } = renderCard(makeItem({ status: 'done' }), { onSetStatus });
		lineButton(container)?.click();
		flushSync();
		buttonByText(container, 'Restore')?.click();
		expect(onSetStatus).toHaveBeenCalledWith('skillbridge-hosts', undefined);
	});

	it('an expanded resolved card re-collapses back to the line', () => {
		const { container } = renderCard(makeItem({ status: 'done' }));
		lineButton(container)?.click();
		flushSync();
		const collapse = container.querySelector(
			'button[aria-expanded="true"]'
		) as HTMLButtonElement | null;
		collapse?.click();
		flushSync();
		expect(lineButton(container)).not.toBeNull();
		expect(container.textContent).not.toContain('Find approved programs that fit your rate.');
	});

	it('open states are not collapsed (upcoming renders the full card immediately)', () => {
		const { container } = renderCard(makeItem({ status: 'upcoming' }));
		expect(lineButton(container)).toBeNull();
		expect(container.textContent).toContain('Find approved programs that fit your rate.');
	});

	it('auto-collapses on a status transition, even from an expanded card (no manual close)', () => {
		const props = $state<{
			item: TimelineItem;
			onSetStatus: (taskId: string, status: TaskStatus | undefined) => void;
			onSetSnooze: (taskId: string, untilIso: string) => void;
		}>({ item: makeItem({ status: 'done' }), onSetStatus: noop, onSetSnooze: noop });
		const { container } = render(TaskCard, { props });

		// User deliberately expands the resolved card to review it.
		(container.querySelector('button.task-line') as HTMLButtonElement | null)?.click();
		flushSync();
		expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();

		// The parent re-resolves it (e.g. restore -> re-mark, or done -> skipped). The card must snap
		// back to its collapsed default on its own - the user shouldn't have to close it.
		props.item = makeItem({ status: 'skipped' });
		flushSync();
		expect(container.querySelector('button.task-line')).not.toBeNull();
		expect(container.textContent).not.toContain('Find approved programs that fit your rate.');
	});

	it('rapid taps toggle deterministically and never stick (some users will mash it)', () => {
		const { container } = renderCard(makeItem({ status: 'done' }));
		const toggle = () =>
			container.querySelector('button[aria-expanded]') as HTMLButtonElement | null;
		expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
		for (let i = 0; i < 6; i++) {
			toggle()?.click();
			flushSync();
		}
		expect(toggle()?.getAttribute('aria-expanded')).toBe('false'); // even taps -> back to collapsed
		toggle()?.click();
		flushSync();
		expect(toggle()?.getAttribute('aria-expanded')).toBe('true'); // odd -> expanded; never stuck
	});

	it('disclosure toggles set touch-action: manipulation (no double-tap zoom / tap delay)', () => {
		const { container } = renderCard(makeItem({ status: 'done' }));
		const line = container.querySelector('button.task-line') as HTMLElement;
		expect(getComputedStyle(line).touchAction).toBe('manipulation');
		line.click();
		flushSync();
		const header = container.querySelector('button.task-card__header') as HTMLElement;
		expect(getComputedStyle(header).touchAction).toBe('manipulation');
	});
});

describe('TaskCard (notes display)', () => {
	it('shows a saved note on an open card, with the action as "Edit note"', () => {
		const { container } = renderCard(makeItem({ note: 'Reached out to 3 hosts.' }));
		expect(container.textContent).toContain('Reached out to 3 hosts.');
		expect(buttonByText(container, 'Edit note')).toBeDefined();
		expect(buttonByText(container, 'Add note')).toBeUndefined(); // Add -> Edit once a note exists
	});

	it('shows a saved note on an expanded resolved card', () => {
		const { container } = renderCard(makeItem({ status: 'done', note: 'Filed via eBenefits.' }));
		(container.querySelector('button.task-line') as HTMLButtonElement | null)?.click();
		flushSync();
		expect(container.textContent).toContain('Filed via eBenefits.');
		expect(buttonByText(container, 'Edit note')).toBeDefined();
	});
});
