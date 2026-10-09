import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import { flushSync } from 'svelte';
import TaskCard from './TaskCard.svelte';
import { snoozeUntilIso } from '$lib/timeline/snooze';
import { addDays, localTodayIso } from '$lib/timeline/day-math';
import { TASK_DEFS } from '$lib/timeline';
import type { TimelineItem, TaskDef, TaskStatus } from '$lib/timeline';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

// TaskCard renders one generated TimelineItem as an open status card: status-color left
// edge + text status label (never color-only) + a status-specific date line + category chip +
// why. The action row: Mark done / Skip + Snooze.

const DEF: TaskDef = {
	id: 'skillbridge-hosts',
	title: 'Research SkillBridge hosts',
	category: 'career',
	finishBefore: 'separation',
	kind: 'soft',
	windowStart: -540,
	windowEnd: -365,
	why: 'Find approved programs that fit your rate.'
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

async function renderCard(
	item: TimelineItem,
	handlers: {
		onSetStatus?: (taskId: string, status: TaskStatus | undefined) => void;
		onSetSnooze?: (taskId: string, untilIso: string) => void;
		onSetNote?: (taskId: string, note: string | undefined) => void;
	} = {}
) {
	return await render(TaskCard, {
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
	it('renders the title, category chip, and why', async () => {
		const { container } = await renderCard(makeItem());
		expect(container.textContent).toContain('Research SkillBridge hosts');
		expect(container.textContent).toContain('Career'); // category label, capitalized
		expect(container.textContent).toContain('Find approved programs that fit your rate.');
	});

	it('shows a collapsed "Related resources (N)" disclosure for a task with mapped resources', async () => {
		const { container } = await renderCard(makeItem({ def: { ...DEF, id: 'job-search' } }));
		const toggle = [...container.querySelectorAll('button')].find((b) =>
			/^Related resources \(\d+\)/.test(b.textContent?.trim() ?? '')
		);
		expect(toggle).toBeTruthy();
		expect(toggle?.getAttribute('aria-expanded')).toBe('false');
		expect(container.querySelector('.task-card__related-list')).toBeNull(); // collapsed
	});

	it('shows no disclosure for a task with no mapped resources', async () => {
		const { container } = await renderCard(makeItem({ def: { ...DEF, id: 'dd214-copies' } }));
		const toggle = [...container.querySelectorAll('button')].find((b) =>
			/^Related resources/.test(b.textContent?.trim() ?? '')
		);
		expect(toggle).toBeUndefined();
	});

	it('expands to show the mapped resources as safe new-tab links', async () => {
		const { container } = await renderCard(makeItem({ def: { ...DEF, id: 'job-search' } }));
		const toggle = [...container.querySelectorAll('button')].find((b) =>
			/^Related resources \(\d+\)/.test(b.textContent?.trim() ?? '')
		);
		toggle?.click();
		flushSync();
		const links = [...container.querySelectorAll('.task-card__related-list a')];
		expect(links.length).toBeGreaterThan(0);
		expect(links[0]?.getAttribute('target')).toBe('_blank');
		const rel = links[0]?.getAttribute('rel') ?? '';
		expect(rel).toContain('noopener');
		expect(rel).toContain('noreferrer');
	});

	it('upcoming: "Upcoming" + when the window opens', async () => {
		const { container } = await renderCard(
			makeItem({ status: 'upcoming', windowStartDate: '2027-03-16' })
		);
		expect(container.querySelector('article')?.classList.contains('status-upcoming')).toBe(true);
		expect(container.textContent).toContain('Upcoming');
		expect(container.textContent).toContain('Opens Mar 16, 2027');
	});

	it('start-now, soft: "Start now" + "Aim for <aim date>"', async () => {
		const { container } = await renderCard(
			makeItem({ status: 'start-now', aimDate: '2026-10-15' })
		);
		expect(container.textContent).toContain('Start now');
		expect(container.textContent).toContain('Aim for Oct 15, 2026');
	});

	it('start-now, firm: "Last day <end>" and a "Firm deadline" tag', async () => {
		const def = { ...DEF, kind: 'closes' as const, afterNote: 'n' };
		const { container } = await renderCard(
			makeItem({ def, status: 'start-now', windowEndDate: '2026-10-20' })
		);
		expect(container.textContent).toContain('Last day Oct 20, 2026');
		expect(container.querySelector('.task-card__firm')?.textContent).toBe('Firm deadline');
	});

	it('closing-soon: the last day and the days left', async () => {
		const def = { ...DEF, kind: 'closes' as const, afterNote: 'n' };
		const { container } = await renderCard(
			makeItem({ def, status: 'closing-soon', windowEndDate: '2026-10-20', daysLeft: 17 })
		);
		expect(container.querySelector('article')?.classList.contains('status-closing-soon')).toBe(
			true
		);
		expect(container.textContent).toContain('Closing soon');
		expect(container.textContent).toContain('Last day Oct 20, 2026');
		expect(container.textContent).toContain('17 days');
	});

	it('closing-soon: the countdown reads "1 day" the day before and "today" on the last day', async () => {
		const def = { ...DEF, kind: 'closes' as const, afterNote: 'n' };
		const days = async (daysLeft: number) =>
			(
				await renderCard(
					makeItem({ def, status: 'closing-soon', windowEndDate: '2026-10-20', daysLeft })
				)
			).container.querySelector('.task-card__days')?.textContent;
		expect(await days(1)).toBe('1 day');
		expect(await days(0)).toBe('today');
	});

	it('late: "Late", when it was due, and the What now note; Mark done stays', async () => {
		const def = { ...DEF, kind: 'required' as const, afterNote: 'Still required.' };
		const { container } = await renderCard(
			makeItem({ def, status: 'late', windowEndDate: '2026-10-20' })
		);
		expect(container.textContent).toContain('Late');
		expect(container.textContent).toContain('was due Oct 20, 2026');
		const box = container.querySelector('.task-card__whatnow')?.textContent ?? '';
		expect(box).toContain('What now');
		expect(box).toContain('Still required.');
		expect(buttonByText(container, 'Mark done')).toBeDefined();
	});

	it('closed: "Closed" + the date + What now', async () => {
		const def = { ...DEF, kind: 'closes' as const, afterNote: 'Gone.' };
		const { container } = await renderCard(
			makeItem({ def, status: 'closed', windowEndDate: '2026-10-20' })
		);
		expect(container.querySelector('article')?.classList.contains('status-closed')).toBe(true);
		expect(container.textContent).toContain('Closed');
		expect(container.querySelector('.task-card__date')?.textContent).toBe('Oct 20, 2026');
		expect(container.querySelector('.task-card__whatnow')?.textContent).toContain('Gone.');
	});

	it('closed two-edge task: the date is its final day', async () => {
		const def = { ...DEF, kind: 'closes' as const, finalEnd: 485, afterNote: 'Gone.' };
		const { container } = await renderCard(
			makeItem({
				def,
				status: 'closed',
				windowEndDate: '2027-09-15',
				finalEndDate: '2028-05-17'
			})
		);
		expect(container.querySelector('.task-card__date')?.textContent).toBe('May 17, 2028');
	});

	// A required task's note says what to do before separation; once separation has passed it no longer applies.
	it('closed after separation: a required task shows no What now note', async () => {
		const def = {
			...DEF,
			kind: 'required' as const,
			afterNote: 'Still required before you separate.'
		};
		const { container } = await renderCard(
			makeItem({ def, status: 'closed', windowEndDate: '2026-10-20' })
		);
		expect(container.textContent).toContain('Closed');
		expect(container.querySelector('.task-card__whatnow')).toBeNull();
	});

	it('changed: "Changed", the final last day, and What changed', async () => {
		const def = {
			...DEF,
			kind: 'closes' as const,
			afterNote: 'Gone.',
			changeNote: 'Now asks health questions.',
			finalEnd: 485
		};
		const { container } = await renderCard(
			makeItem({ def, status: 'changed', windowEndDate: '2027-09-15', finalEndDate: '2028-05-17' })
		);
		expect(container.textContent).toContain('Changed');
		expect(container.textContent).toContain('Last day May 17, 2028');
		const box = container.querySelector('.task-card__whatnow')?.textContent ?? '';
		expect(box).toContain('What changed');
		expect(box).toContain('Now asks health questions.');
	});

	it('still-to-do: calm "Still to do", "Aimed for <end>", no tag, no What now', async () => {
		const { container } = await renderCard(
			makeItem({ status: 'still-to-do', windowEndDate: '2026-07-22' })
		);
		expect(container.querySelector('article')?.classList.contains('status-still-to-do')).toBe(true);
		expect(container.textContent).toContain('Still to do');
		expect(container.textContent).toContain('Aimed for Jul 22, 2026');
		expect(container.querySelector('.task-card__firm')).toBeNull();
		expect(container.querySelector('.task-card__whatnow')).toBeNull();
	});

	it('an open card carries an anchor id the summary links to', async () => {
		const { container } = await renderCard(makeItem());
		expect(container.querySelector('article')?.id).toBe('task-skillbridge-hosts');
	});

	it('What now links to the official page for the task, in a new tab, under an uppercase label', async () => {
		const def = { ...DEF, id: 'va-bdd-claim', kind: 'closes' as const, afterNote: 'Gone.' };
		const { container } = await renderCard(
			makeItem({ def, status: 'closed', windowEndDate: '2026-10-20' })
		);
		const link = container.querySelector('.task-card__whatnow a');
		expect(link?.textContent).toContain('Find a VSO on VA.gov');
		expect(link?.getAttribute('href')).toBe(
			'https://www.va.gov/get-help-from-accredited-representative/'
		);
		expect(link?.getAttribute('target')).toBe('_blank');
		expect(link?.getAttribute('rel')).toContain('noopener');
		expect(link?.getAttribute('rel')).toContain('noreferrer');
		const label = container.querySelector('.task-card__whatnow-label') as HTMLElement;
		expect(getComputedStyle(label).textTransform).toBe('uppercase');
	});

	it('a firm card with no curated page shows its note without a link', async () => {
		const def = { ...DEF, kind: 'closes' as const, afterNote: 'Gone.' };
		const { container } = await renderCard(
			makeItem({ def, status: 'closed', windowEndDate: '2026-10-20' })
		);
		expect(container.querySelector('.task-card__whatnow')?.textContent).toContain('Gone.');
		expect(container.querySelector('.task-card__whatnow a')).toBeNull();
	});

	it('the "Firm deadline" tag keeps to one line', async () => {
		const def = { ...DEF, kind: 'closes' as const, afterNote: 'n' };
		const { container } = await renderCard(makeItem({ def, status: 'start-now' }));
		const tag = container.querySelector('.task-card__firm') as HTMLElement;
		expect(getComputedStyle(tag).whiteSpace).toBe('nowrap');
	});

	it('color-codes the category chip via a category-<name> class (text label still present)', async () => {
		const career = await renderCard(makeItem());
		const careerChip = career.container.querySelector('.task-card__chip');
		expect(careerChip?.classList.contains('category-career')).toBe(true);
		expect(careerChip?.textContent).toBe('Career'); // color is an aid; the label still carries it

		const medical = await renderCard(makeItem({ def: { ...DEF, category: 'medical' } }));
		expect(
			medical.container.querySelector('.task-card__chip')?.classList.contains('category-medical')
		).toBe(true);
	});

	it('renders Mark done, Skip, and Snooze actions on an open card', async () => {
		const { container } = await renderCard(makeItem());
		expect(buttonByText(container, 'Mark done')).toBeDefined();
		expect(buttonByText(container, 'Skip')).toBeDefined();
		expect(buttonByText(container, 'Snooze')).toBeDefined();
	});

	it('Mark done calls onSetStatus(id, "done")', async () => {
		const onSetStatus = vi.fn();
		const { container } = await renderCard(makeItem(), { onSetStatus });
		buttonByText(container, 'Mark done')?.click();
		expect(onSetStatus).toHaveBeenCalledWith('skillbridge-hosts', 'done');
	});

	it('Skip calls onSetStatus(id, "skipped")', async () => {
		const onSetStatus = vi.fn();
		const { container } = await renderCard(makeItem(), { onSetStatus });
		buttonByText(container, 'Skip')?.click();
		expect(onSetStatus).toHaveBeenCalledWith('skillbridge-hosts', 'skipped');
	});

	// A snooze can never hide a firm warning, so the card does not offer one there: the tap would change nothing.
	it('offers Snooze only where a snooze can quiet the card', async () => {
		const firmDef = { ...DEF, kind: 'closes' as const, afterNote: 'n' };
		for (const status of ['closing-soon', 'late', 'changed', 'closed'] as const) {
			const card = (
				await renderCard(
					makeItem({ def: firmDef, status, windowEndDate: '2026-10-20', daysLeft: 5 })
				)
			).container;
			expect(buttonByText(card, 'Snooze'), status).toBeUndefined();
			expect(buttonByText(card, 'Mark done'), status).toBeDefined();
		}
		for (const status of ['upcoming', 'start-now', 'still-to-do'] as const) {
			expect(
				buttonByText((await renderCard(makeItem({ status }))).container, 'Snooze'),
				status
			).toBeDefined();
		}
	});

	// The day can turn (or a date change land from another tab) while the picker is open; when the card turns firm
	// the picker closes with its button, so no preset is left that would change nothing.
	it('closes an open Snooze picker when the card turns firm', async () => {
		const firmDef = { ...DEF, kind: 'closes' as const, afterNote: 'n' };
		const props = $state<{
			item: TimelineItem;
			onSetStatus: (taskId: string, status: TaskStatus | undefined) => void;
			onSetSnooze: (taskId: string, untilIso: string) => void;
		}>({
			item: makeItem({ def: firmDef, status: 'start-now' }),
			onSetStatus: noop,
			onSetSnooze: noop
		});
		const { container } = await render(TaskCard, { props });
		buttonByText(container, 'Snooze')?.click();
		flushSync();
		expect(buttonByText(container, '1 week')).toBeDefined();
		props.item = makeItem({
			def: firmDef,
			status: 'closing-soon',
			windowEndDate: '2026-10-20',
			daysLeft: 5
		});
		flushSync();
		expect(buttonByText(container, 'Snooze')).toBeUndefined();
		expect(buttonByText(container, '1 week')).toBeUndefined();
	});

	// 38 CFR 14.629: the words the card adds around a task - status, dates, tags, What now and What changed - make
	// no personal claim in any state (the task data itself is checked in task-defs.test.ts).
	it('adds no personal eligibility claim in any state', async () => {
		const firm = { ...DEF, id: 'va-bdd-claim', kind: 'closes' as const, afterNote: 'n' };
		const twoEdge = { ...firm, finalEnd: 485, changeNote: 'c' };
		const states: Partial<TimelineItem>[] = [
			{ status: 'upcoming' },
			{ status: 'start-now', aimDate: '2026-10-15' },
			{ status: 'still-to-do' },
			{ def: firm, status: 'start-now' },
			{ def: firm, status: 'closing-soon', daysLeft: 5 },
			{ def: { ...firm, kind: 'required' }, status: 'late' },
			{ def: twoEdge, status: 'changed', finalEndDate: '2027-05-17', daysLeft: 20 },
			{ def: firm, status: 'closed' },
			{ status: 'done' },
			{ status: 'skipped' },
			{ status: 'snoozed', snoozeUntil: '2026-11-01' }
		];
		for (const state of states) {
			const text = textOf((await renderCard(makeItem(state))).container);
			expect(makesPersonalClaim(text), text).toBe(false);
		}
	});

	it('Snooze opens a picker with presets and a pick-a-date option', async () => {
		const { container } = await renderCard(makeItem());
		buttonByText(container, 'Snooze')?.click();
		flushSync();
		expect(buttonByText(container, '1 week')).toBeDefined();
		expect(buttonByText(container, '1 month')).toBeDefined();
		expect(buttonByText(container, '3 months')).toBeDefined();
		expect(buttonByText(container, 'Customize')).toBeDefined();
	});

	it('a snooze preset calls onSetSnooze with the computed ISO date', async () => {
		const onSetSnooze = vi.fn();
		const { container } = await renderCard(makeItem(), { onSetSnooze });
		buttonByText(container, 'Snooze')?.click();
		flushSync();
		buttonByText(container, '1 week')?.click();
		expect(onSetSnooze).toHaveBeenCalledWith('skillbridge-hosts', snoozeUntilIso(new Date(), 7));
	});

	it('Customize reveals a date input; confirming calls onSetSnooze with that date', async () => {
		const onSetSnooze = vi.fn();
		const { container } = await renderCard(makeItem(), { onSetSnooze });
		buttonByText(container, 'Snooze')?.click();
		flushSync();
		buttonByText(container, 'Customize')?.click();
		flushSync();
		const input = container.querySelector('input[type="date"]') as HTMLInputElement | null;
		if (!input) throw new Error('no date input rendered');
		const tomorrow = snoozeUntilIso(new Date(), 1);
		input.value = tomorrow;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		const confirm = container.querySelector(
			'.task-card__date-row button'
		) as HTMLButtonElement | null;
		confirm?.click();
		expect(onSetSnooze).toHaveBeenCalledWith('skillbridge-hosts', tomorrow);
	});

	it('asks the browser not to keep a typed snooze date in its autofill history', async () => {
		const { container } = await renderCard(makeItem());
		buttonByText(container, 'Snooze')?.click();
		flushSync();
		buttonByText(container, 'Customize')?.click();
		flushSync();
		const input = container.querySelector('input[type="date"]');
		if (!input) throw new Error('no date input rendered');
		expect(input.getAttribute('autocomplete')).toBe('off');
	});

	it('keeps a typed note away from cloud spellcheck', async () => {
		const { container } = await renderCard(makeItem());
		buttonByText(container, 'Add note')?.click();
		flushSync();
		const textarea = container.querySelector('textarea');
		if (!textarea) throw new Error('no note textarea rendered');
		expect(textarea.getAttribute('spellcheck')).toBe('false');
	});

	it('Add note reveals a textarea; Save calls onSetNote with the text', async () => {
		const onSetNote = vi.fn();
		const { container } = await renderCard(makeItem(), { onSetNote });
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

	it('Cancel closes the note editor without saving', async () => {
		const onSetNote = vi.fn();
		const { container } = await renderCard(makeItem(), { onSetNote });
		buttonByText(container, 'Add note')?.click();
		flushSync();
		buttonByText(container, 'Cancel')?.click();
		flushSync();
		expect(onSetNote).not.toHaveBeenCalled();
		expect(container.querySelector('textarea')).toBeNull();
	});
});

// A snooze is live only while its date is after today, so the custom picker offers tomorrow at the earliest, and
// nothing past the largest year a date field holds in four digits.
describe('TaskCard (custom snooze date)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	async function openCustomize(onSetSnooze: (taskId: string, untilIso: string) => void) {
		const { container } = await renderCard(makeItem(), { onSetSnooze });
		buttonByText(container, 'Snooze')?.click();
		flushSync();
		buttonByText(container, 'Customize')?.click();
		flushSync();
		const input = container.querySelector('input[type="date"]') as HTMLInputElement | null;
		if (!input) throw new Error('no date input rendered');
		const go = container.querySelector('.task-card__date-row button') as HTMLButtonElement | null;
		if (!go) throw new Error('no snooze button rendered');
		const type = (value: string) => {
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
		};
		return { input, go, type };
	}

	it('offers tomorrow as the earliest date', async () => {
		const { input } = await openCustomize(noop);
		expect(input.min).toBe(snoozeUntilIso(new Date(), 1));
	});

	it('refuses today: the button is off and a tap sets no snooze', async () => {
		const onSetSnooze = vi.fn();
		const { go, type } = await openCustomize(onSetSnooze);
		type(snoozeUntilIso(new Date(), 0));
		expect(go.disabled).toBe(true);
		go.click();
		expect(onSetSnooze).not.toHaveBeenCalled();
	});

	it('refuses a past date: the button is off and a tap sets no snooze', async () => {
		const onSetSnooze = vi.fn();
		const { go, type } = await openCustomize(onSetSnooze);
		type(snoozeUntilIso(new Date(), -3));
		expect(go.disabled).toBe(true);
		go.click();
		expect(onSetSnooze).not.toHaveBeenCalled();
	});

	// Positive control: this holds on the old code too.
	it('takes tomorrow: the button is on and a tap sets the snooze', async () => {
		const onSetSnooze = vi.fn();
		const { go, type } = await openCustomize(onSetSnooze);
		const tomorrow = snoozeUntilIso(new Date(), 1);
		type(tomorrow);
		expect(go.disabled).toBe(false);
		go.click();
		expect(onSetSnooze).toHaveBeenCalledTimes(1);
		expect(onSetSnooze).toHaveBeenCalledWith('skillbridge-hosts', tomorrow);
	});

	it('re-reads today at the tap: a date that was tomorrow at midnight is refused', async () => {
		const evening = new Date();
		evening.setHours(23, 59, 0, 0);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(evening);
		const onSetSnooze = vi.fn();
		const { go, type } = await openCustomize(onSetSnooze);
		const nextDay = addDays(localTodayIso(evening), 1);
		type(nextDay);
		expect(go.disabled).toBe(false);
		vi.setSystemTime(
			new Date(evening.getFullYear(), evening.getMonth(), evening.getDate() + 1, 0, 1)
		);
		go.click();
		flushSync();
		expect(onSetSnooze).not.toHaveBeenCalled();
		expect(go.disabled).toBe(true);
	});

	it('stops at year 9999: the field says so and a five-digit year is refused', async () => {
		const onSetSnooze = vi.fn();
		const { input, go, type } = await openCustomize(onSetSnooze);
		expect(input.max).toBe('9999-12-31');
		type('30000-01-01');
		expect(input.value).toBe('30000-01-01');
		expect(go.disabled).toBe(true);
		go.click();
		expect(onSetSnooze).not.toHaveBeenCalled();
	});
});

// Resolved tasks (done/skipped/snoozed) collapse to a one-line disclosure
// (decision A: snoozed shows "to <date>"; done/skipped show no date). Tapping expands to the
// full card with a unified Restore action (decision B: onSetStatus(id, undefined)). Open states
// are unchanged. Collapse state is ephemeral local $state.
describe('TaskCard (resolved / collapsed states)', () => {
	function lineButton(container: Element): HTMLButtonElement | null {
		return container.querySelector('button.task-line');
	}

	it('done: collapses to a disclosure line (aria-expanded=false), no date, why hidden', async () => {
		const { container } = await renderCard(makeItem({ status: 'done' }));
		const line = lineButton(container);
		expect(line).not.toBeNull();
		expect(line?.getAttribute('aria-expanded')).toBe('false');
		expect(line?.textContent).toContain('Research SkillBridge hosts');
		expect(line?.textContent).toContain('Done');
		expect(container.querySelector('.task-line__date')).toBeNull(); // decision A: no date for done
		expect(container.textContent).not.toContain('Find approved programs that fit your rate.');
	});

	it('snoozed: collapsed line shows "Snoozed" + "to <date>" (decision A)', async () => {
		const { container } = await renderCard(
			makeItem({ status: 'snoozed', snoozeUntil: '2026-08-01' })
		);
		expect(lineButton(container)?.textContent).toContain('Snoozed');
		expect(container.querySelector('.task-line__date')?.textContent).toContain('to Aug 1, 2026');
	});

	it('skipped: collapsed line shows "Skipped" + no date (decision A)', async () => {
		const { container } = await renderCard(makeItem({ status: 'skipped' }));
		expect(lineButton(container)?.textContent).toContain('Skipped');
		expect(container.querySelector('.task-line__date')).toBeNull();
	});

	it('expanding a resolved task reveals the full card + a Restore action', async () => {
		const { container } = await renderCard(makeItem({ status: 'done' }));
		lineButton(container)?.click();
		flushSync();
		expect(container.textContent).toContain('Find approved programs that fit your rate.');
		expect(buttonByText(container, 'Restore')).toBeDefined();
		expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
	});

	it('the expanded collapse control is the header row (contains the title), not a bare caret', async () => {
		const { container } = await renderCard(makeItem({ status: 'done' }));
		(container.querySelector('button.task-line') as HTMLButtonElement | null)?.click();
		flushSync();
		const toggle = container.querySelector('button[aria-expanded="true"]');
		expect(toggle?.textContent).toContain('Research SkillBridge hosts'); // tap the whole header, not a caret
	});

	it('Restore clears the status via onSetStatus(id, undefined) (decision B)', async () => {
		const onSetStatus = vi.fn();
		const { container } = await renderCard(makeItem({ status: 'done' }), { onSetStatus });
		lineButton(container)?.click();
		flushSync();
		buttonByText(container, 'Restore')?.click();
		expect(onSetStatus).toHaveBeenCalledWith('skillbridge-hosts', undefined);
	});

	it('an expanded resolved card re-collapses back to the line', async () => {
		const { container } = await renderCard(makeItem({ status: 'done' }));
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

	it('open states are not collapsed (upcoming renders the full card immediately)', async () => {
		const { container } = await renderCard(makeItem({ status: 'upcoming' }));
		expect(lineButton(container)).toBeNull();
		expect(container.textContent).toContain('Find approved programs that fit your rate.');
	});

	it('auto-collapses on a status transition, even from an expanded card (no manual close)', async () => {
		const props = $state<{
			item: TimelineItem;
			onSetStatus: (taskId: string, status: TaskStatus | undefined) => void;
			onSetSnooze: (taskId: string, untilIso: string) => void;
		}>({ item: makeItem({ status: 'done' }), onSetStatus: noop, onSetSnooze: noop });
		const { container } = await render(TaskCard, { props });

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

	it('rapid taps toggle deterministically and never stick (some users will mash it)', async () => {
		const { container } = await renderCard(makeItem({ status: 'done' }));
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

	it('disclosure toggles set touch-action: manipulation (no double-tap zoom / tap delay)', async () => {
		const { container } = await renderCard(makeItem({ status: 'done' }));
		const line = container.querySelector('button.task-line') as HTMLElement;
		expect(getComputedStyle(line).touchAction).toBe('manipulation');
		line.click();
		flushSync();
		const header = container.querySelector('button.task-card__header') as HTMLElement;
		expect(getComputedStyle(header).touchAction).toBe('manipulation');
	});
});

describe('TaskCard (notes display)', () => {
	it('shows a saved note on an open card, with the action as "Edit note"', async () => {
		const { container } = await renderCard(makeItem({ note: 'Reached out to 3 hosts.' }));
		expect(container.textContent).toContain('Reached out to 3 hosts.');
		expect(buttonByText(container, 'Edit note')).toBeDefined();
		expect(buttonByText(container, 'Add note')).toBeUndefined(); // Add -> Edit once a note exists
	});

	it('shows a saved note on an expanded resolved card', async () => {
		const { container } = await renderCard(
			makeItem({ status: 'done', note: 'Filed via eBenefits.' })
		);
		(container.querySelector('button.task-line') as HTMLButtonElement | null)?.click();
		flushSync();
		expect(container.textContent).toContain('Filed via eBenefits.');
		expect(buttonByText(container, 'Edit note')).toBeDefined();
	});

	it('marks a collapsed resolved line with a note-dot when a note exists', async () => {
		const withNote = await renderCard(makeItem({ status: 'done', note: 'see VSO' }));
		expect(withNote.container.querySelector('.task-line__note-dot')).not.toBeNull();
		const without = await renderCard(makeItem({ status: 'done' }));
		expect(without.container.querySelector('.task-line__note-dot')).toBeNull();
	});
});

// The card's two columns (text left, status and date right) need room; on a phone the status line moves above the
// title so the text gets the card's full width. The frame's size is put back after each case.
describe('TaskCard (layout by width)', () => {
	let size = { width: 0, height: 0 };
	beforeEach(() => {
		size = { width: window.innerWidth, height: window.innerHeight };
	});
	afterEach(async () => {
		await page.viewport(size.width, size.height);
	});

	const firm = { ...DEF, kind: 'closes' as const, afterNote: 'n' };
	const closing = makeItem({
		def: firm,
		status: 'closing-soon',
		windowEndDate: '2026-10-20',
		daysLeft: 17
	});
	const box = (container: Element, selector: string) =>
		(container.querySelector(selector) as HTMLElement).getBoundingClientRect();

	it('on a 320 px phone the status line sits above the title', async () => {
		await page.viewport(320, 800);
		const { container } = await renderCard(closing);
		expect(box(container, '.task-card__meta').bottom).toBeLessThanOrEqual(
			box(container, '.task-card__title').top
		);
	});

	it('on a phone a wrapping status line keeps the date and its countdown together', async () => {
		await page.viewport(320, 800);
		const { container } = await renderCard(closing);
		(container as HTMLElement).style.width = '288px';
		const status = box(container, '.task-card__status');
		const date = box(container, '.task-card__date');
		// The line wraps (the case under test is reached), and it breaks after the status, never inside the date.
		expect(date.top).toBeGreaterThan(status.top);
		expect(box(container, '.task-card__days').top).toBe(date.top);
	});

	it('on a phone a moved date wraps before its reason and stays inside the card', async () => {
		await page.viewport(320, 800);
		const { container } = await renderCard(
			makeItem({
				def: firm,
				status: 'closing-soon',
				windowEndDate: '2026-10-31',
				daysLeft: 27,
				fit: { reason: 'skillbridge', date: '2026-10-31' }
			})
		);
		(container as HTMLElement).style.width = '288px';
		const reason = box(container, '.task-card__reason-words');
		// The line wraps (the case under test is reached), the reason starting a line of its own...
		expect(reason.top).toBeGreaterThan(box(container, '.task-card__status').top);
		// ...with its countdown beside it, and nothing passes the card's edge.
		expect(box(container, '.task-card__days').top).toBe(reason.top);
		expect(box(container, '.task-card__when').right).toBeLessThanOrEqual(
			box(container, 'article').right
		);
	});

	it('on a wide screen the status line sits beside the title', async () => {
		await page.viewport(1024, 800);
		const { container } = await renderCard(closing);
		const meta = box(container, '.task-card__meta');
		const title = box(container, '.task-card__title');
		expect(meta.top).toBeLessThan(title.bottom);
		expect(meta.left).toBeGreaterThanOrEqual(title.right);
	});

	it('on a 320 px phone a long word stays inside the What now box', async () => {
		await page.viewport(320, 800);
		// One unbroken word: a hyphen is a line-break opportunity, so it would not test the overflow.
		const def = { ...firm, afterNote: 'ContactYourCommandsTransitionAssistanceOfficeToStartNow.' };
		const { container } = await renderCard(
			makeItem({ def, status: 'closed', windowEndDate: '2026-10-20' })
		);
		const note = container.querySelector('.task-card__whatnow') as HTMLElement;
		expect(note.scrollWidth).toBeLessThanOrEqual(note.clientWidth);
		// ...and the box itself stays inside the card: a column that sizes to its longest word would widen both.
		expect(note.getBoundingClientRect().right).toBeLessThanOrEqual(box(container, 'article').right);
	});

	it('on a 320 px phone a long word in a saved note does not widen the text column past the card', async () => {
		await page.viewport(320, 800);
		const note =
			'https://www.example.gov/a/very/long/address/with/no/spaces/that/a/user/pasted/into/a/note';
		const { container } = await renderCard(makeItem({ def: firm, status: 'start-now', note }));
		expect(box(container, '.task-card__body').right).toBeLessThanOrEqual(
			box(container, 'article').right
		);
	});

	it('on a 320 px phone a long word in a saved note wraps inside its box', async () => {
		await page.viewport(320, 800);
		const note =
			'https://www.example.gov/a/very/long/address/with/no/spaces/that/a/user/pasted/into/a/note';
		const { container } = await renderCard(makeItem({ def: firm, status: 'start-now', note }));
		const shown = container.querySelector('.task-card__note-shown') as HTMLElement;
		expect(shown.scrollWidth).toBeLessThanOrEqual(shown.clientWidth);
	});
});

// What a keyboard or screen-reader user meets: the link's place, the jump's landing, and words kept apart.
describe('TaskCard (for keyboard and screen reader)', () => {
	it('puts the What now link on its own line, under the note', async () => {
		const def = { ...DEF, id: 'tricare-elect', kind: 'closes' as const, afterNote: 'Gone.' };
		const { container } = await renderCard(
			makeItem({ def, status: 'closed', windowEndDate: '2026-10-20' })
		);
		const box = container.querySelector('.task-card__whatnow') as HTMLElement;
		const link = box.querySelector('a') as HTMLElement;
		const note = [...box.childNodes].find((n) => n.textContent?.includes('Gone.')) as Node;
		const range = document.createRange();
		range.selectNodeContents(note);
		expect(link.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			range.getBoundingClientRect().bottom - 1
		);
	});

	it('takes focus when the timeline jumps to it', async () => {
		const card = (await renderCard(makeItem({ status: 'start-now' }))).container.querySelector(
			'article'
		) as HTMLElement;
		card.focus();
		expect(document.activeElement).toBe(card);
	});

	it('separates the tags from the text with spaces, so they are not read as one word', async () => {
		const def = { ...DEF, kind: 'closes' as const, afterNote: 'n' };
		const open = (await renderCard(makeItem({ def, status: 'start-now' }))).container;
		expect(open.querySelector('.task-card__why')?.textContent).toMatch(
			/^Career Firm deadline Find approved/
		);
		const resolved = (await renderCard(makeItem({ status: 'done' }))).container;
		(resolved.querySelector('button.task-line') as HTMLButtonElement).click();
		flushSync();
		expect(resolved.querySelector('.task-card__why')?.textContent).toMatch(/^Career Find approved/);
	});
});

describe('leaving your command', () => {
	const firmDef: TaskDef = { ...DEF, id: 'sha', kind: 'required' };

	it('names the reason on a date Fit moved', async () => {
		await renderCard(
			makeItem({
				def: firmDef,
				status: 'closing-soon',
				windowEndDate: '2026-10-31',
				daysLeft: 27,
				fit: { reason: 'skillbridge', date: '2026-10-31' }
			})
		);
		await expect.element(page.getByText('Last day Oct 31, 2026, before SkillBridge')).toBeVisible();
	});

	it('names no reason on a date Fit left alone', async () => {
		await renderCard(
			makeItem({
				status: 'start-now',
				aimDate: '2026-09-02',
				windowEndDate: '2026-10-31',
				fit: { reason: 'skillbridge', date: '2026-10-31' }
			})
		);
		await expect.element(page.getByText('Aim for Sep 2, 2026')).toBeVisible();
		expect(page.getByText(/before SkillBridge/).query()).toBeNull();
	});

	// Every dated status names the reason when its date is the one Fit moved.
	const FIT: NonNullable<TimelineItem['fit']> = { reason: 'skillbridge', date: '2026-10-31' };
	const REASON_CASES: [string, Partial<TimelineItem>, string][] = [
		[
			'a firm last day',
			{ def: firmDef, status: 'start-now' },
			'Last day Oct 31, 2026, before SkillBridge'
		],
		[
			'an aim date',
			{ status: 'start-now', aimDate: '2026-10-31' },
			'Aim for Oct 31, 2026, before SkillBridge'
		],
		[
			'a date that was due',
			{ def: firmDef, status: 'late' },
			'was due Oct 31, 2026, before SkillBridge'
		],
		[
			'an aim that has passed',
			{ status: 'still-to-do' },
			'Aimed for Oct 31, 2026, before SkillBridge'
		],
		[
			'a last day before terminal leave',
			{
				def: firmDef,
				status: 'closing-soon',
				daysLeft: 27,
				fit: { reason: 'terminal-leave', date: '2026-10-31' }
			},
			'Last day Oct 31, 2026, before terminal leave'
		]
	];
	for (const [name, over, text] of REASON_CASES) {
		it(`names the reason on ${name}`, async () => {
			await renderCard(makeItem({ windowEndDate: '2026-10-31', fit: FIT, ...over }));
			await expect.element(page.getByText(text)).toBeVisible();
		});
	}

	it('a firm task that cannot fit warns: the opening, the What now box, no Snooze', async () => {
		const { container } = await renderCard(
			makeItem({ def: firmDef, status: 'after-you-leave', windowStartDate: '2026-12-01' })
		);
		await expect.element(page.getByText('After you leave', { exact: true })).toBeVisible();
		await expect.element(page.getByText('Opens Dec 1, 2026')).toBeVisible();
		await expect
			.element(
				page.getByText(
					/This opens after you leave your command\. Ask your command how to fit it in\./
				)
			)
			.toBeVisible();
		expect(page.getByRole('button', { name: /^snooze$/i }).query()).toBeNull();
		expect(container.querySelector('article')?.classList.contains('task-card--calm')).toBe(false);
	});

	it('a soft task that cannot fit stays calm and keeps Snooze', async () => {
		const { container } = await renderCard(
			makeItem({ status: 'after-you-leave', windowStartDate: '2027-01-30' })
		);
		await expect.element(page.getByRole('button', { name: /^snooze$/i })).toBeVisible();
		expect(container.querySelector('article')?.classList.contains('task-card--calm')).toBe(true);
	});

	it('says nothing about what the user qualifies for', async () => {
		const { container } = await renderCard(
			makeItem({ def: firmDef, status: 'after-you-leave', windowStartDate: '2026-12-01' })
		);
		for (const line of textOf(container).split('\n')) expect(makesPersonalClaim(line)).toBe(false);
	});
});

describe("the line above a SkillBridge step's links", () => {
	const request = TASK_DEFS.find((t) => t.id === 'skillbridge-request');

	it('shows the command-instructions line first in the open list, outside the links', async () => {
		if (!request) throw new Error('E_TEST_TASK_MISSING');
		const { container } = await render(TaskCard, {
			props: { item: makeItem({ def: request }), onSetStatus: noop, onSetSnooze: noop }
		});
		await page.getByRole('button', { name: /^Related resources \(2\)/ }).click();
		const note = container.querySelector('.task-card__related-note');
		expect(note?.textContent).toBe(
			"Also follow your command's SkillBridge instructions: they set what your request package needs."
		);
		expect(note?.nextElementSibling?.tagName).toBe('UL');
		expect(container.querySelectorAll('.task-card__related-list li')).toHaveLength(2);
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);
	});

	it('shows no line for a task without one', async () => {
		const { container } = await render(TaskCard, {
			props: { item: makeItem(), onSetStatus: noop, onSetSnooze: noop }
		});
		const toggle = page.getByRole('button', { name: /^Related resources/ });
		if (toggle.elements().length) await toggle.click();
		expect(container.querySelector('.task-card__related-note')).toBeNull();
	});

	it('shows no line above the open links of a task that has links but no line', async () => {
		const { container } = await render(TaskCard, {
			props: {
				item: makeItem({ def: { ...DEF, id: 'job-search' } }),
				onSetStatus: noop,
				onSetSnooze: noop
			}
		});
		await page.getByRole('button', { name: /^Related resources \(\d+\)/ }).click();
		expect(container.querySelectorAll('.task-card__related-list li').length).toBeGreaterThan(0);
		expect(container.querySelector('.task-card__related-note')).toBeNull();
	});

	it('shows the line only while the links are open', async () => {
		if (!request) throw new Error('E_TEST_TASK_MISSING');
		const { container } = await render(TaskCard, {
			props: { item: makeItem({ def: request }), onSetStatus: noop, onSetSnooze: noop }
		});
		expect(container.querySelector('.task-card__related-note')).toBeNull();
		await page.getByRole('button', { name: /^Related resources \(2\)/ }).click();
		expect(container.querySelector('.task-card__related-note')).not.toBeNull();
		await page.getByRole('button', { name: /^Related resources \(2\)/ }).click();
		expect(container.querySelector('.task-card__related-note')).toBeNull();
	});
});
