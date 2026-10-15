import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { flushSync } from 'svelte';
import TaskCard from './TaskCard.svelte';
import { SNOOZE_DATE_MAX, snoozeUntilIso } from '$lib/timeline/snooze';
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
		status: 'start-now',
		...overrides
	};
}

async function renderCard(
	item: TimelineItem,
	handlers: {
		onSetStatus?: (taskId: string, status: TaskStatus | undefined) => void;
		onSetSnooze?: (taskId: string, untilIso: string) => void;
		onSetNote?: (taskId: string, note: string | undefined) => Promise<void>;
	} = {}
) {
	return await render(TaskCard, {
		props: {
			item,
			onSetStatus: handlers.onSetStatus ?? noop,
			onSetSnooze: handlers.onSetSnooze ?? noop,
			onSetNote: handlers.onSetNote ?? (async () => {})
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

	// The card and the "Just closed" row name the same day: a required task closes at separation, not at its window end.
	it('closed required task: the date is the day it closed, as in Just closed', async () => {
		const def = { ...DEF, kind: 'required' as const };
		const { container } = await renderCard(
			makeItem({ def, status: 'closed', windowEndDate: '2027-01-20', closedOn: '2027-03-05' })
		);
		expect(container.querySelector('.task-card__date')?.textContent).toBe('Mar 5, 2027');
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

	it('still-to-do with a lapsed aim: "Still to do" and no date', async () => {
		const { container } = await renderCard(
			makeItem({ status: 'still-to-do', windowEndDate: '2024-06-03', aimLapsed: true })
		);
		expect(container.textContent).toContain('Still to do');
		expect(container.textContent).not.toContain('Aimed for');
		expect(container.textContent).not.toContain('2024');
		expect(container.querySelector('.task-card__date')).toBeNull();
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

	// A snooze can never hide a firm warning, so the card does not offer one there: the tap would change nothing. Before
	// a window opens there is nothing to quiet either, and a snooze date would fall before the opening the card names.
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
		const upcoming = (await renderCard(makeItem({ status: 'upcoming' }))).container;
		expect(buttonByText(upcoming, 'Snooze')).toBeUndefined();
		expect(buttonByText(upcoming, 'Mark done')).toBeDefined();
		for (const status of ['start-now', 'still-to-do'] as const) {
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

	const SAVE_FAILED = 'Could not update right now - please try again.';

	async function typeNote(container: Element, text: string): Promise<HTMLTextAreaElement> {
		buttonByText(container, 'Add note')?.click();
		flushSync();
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null;
		if (!textarea) throw new Error('no note textarea rendered');
		textarea.value = text;
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		return textarea;
	}

	it('a failed Save keeps the editor open with the typed text and says so', async () => {
		const onSetNote = vi.fn(async () => {
			throw new Error('E_NOTE_SAVE');
		});
		const { container } = await renderCard(makeItem(), { onSetNote });
		await typeNote(container, 'Call the VSO Monday');
		buttonByText(container, 'Save')?.click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(SAVE_FAILED);
		const textarea = container.querySelector('textarea');
		expect(textarea?.value).toBe('Call the VSO Monday');
		expect(container.querySelector('.task-card__note [role="alert"]')).not.toBeNull();
	});

	it('a Save that works after a failed one closes the editor and drops the line', async () => {
		const onSetNote = vi
			.fn<(taskId: string, note: string | undefined) => Promise<void>>()
			.mockRejectedValueOnce(new Error('E_NOTE_SAVE'))
			.mockResolvedValueOnce(undefined);
		const { container } = await renderCard(makeItem(), { onSetNote });
		await typeNote(container, 'Call the VSO Monday');
		buttonByText(container, 'Save')?.click();
		await expect.element(page.getByRole('alert')).toBeVisible();
		buttonByText(container, 'Save')?.click();
		await expect.poll(() => container.querySelector('textarea')).toBeNull();
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(onSetNote).toHaveBeenCalledTimes(2);
	});

	it('Cancel after a failed Save drops the line, and the next edit starts without it', async () => {
		const onSetNote = vi.fn(async () => {
			throw new Error('E_NOTE_SAVE');
		});
		const { container } = await renderCard(makeItem(), { onSetNote });
		await typeNote(container, 'Call the VSO Monday');
		buttonByText(container, 'Save')?.click();
		await expect.element(page.getByRole('alert')).toBeVisible();
		buttonByText(container, 'Cancel')?.click();
		flushSync();
		expect(container.querySelector('textarea')).toBeNull();
		buttonByText(container, 'Add note')?.click();
		flushSync();
		expect(container.querySelector('textarea')).not.toBeNull();
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	it('the line goes when the next Save starts', async () => {
		let release: () => void = () => {};
		const onSetNote = vi
			.fn<(taskId: string, note: string | undefined) => Promise<void>>()
			.mockRejectedValueOnce(new Error('E_NOTE_SAVE'))
			.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
		const { container } = await renderCard(makeItem(), { onSetNote });
		await typeNote(container, 'Call the VSO Monday');
		buttonByText(container, 'Save')?.click();
		await expect.element(page.getByRole('alert')).toBeVisible();
		buttonByText(container, 'Save')?.click();
		await expect.poll(() => container.querySelector('[role="alert"]')).toBeNull();
		release();
		await expect.poll(() => container.querySelector('textarea')).toBeNull();
	});

	it('a second Save while one is pending is ignored, and the button stays enabled', async () => {
		let release: () => void = () => {};
		const onSetNote = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
		const { container } = await renderCard(makeItem(), { onSetNote });
		await typeNote(container, 'Call the VSO Monday');
		const save = buttonByText(container, 'Save');
		save?.click();
		save?.click();
		flushSync();
		expect(onSetNote).toHaveBeenCalledTimes(1);
		expect(save?.disabled).toBe(false);
		release();
		await expect.poll(() => container.querySelector('textarea')).toBeNull();
	});

	// A held key repeats about every 40 ms; a save that fails inside the hold leaves the editor open with focus on Save,
	// so the repeats after it would save again. Only a new press saves. The keys go through the browser's own input.
	it.each([
		['at once', 0],
		['after a while', 100]
	] as const)('a held Enter on Save saves once when the save fails %s', async (_, ms) => {
		const ENTER = {
			key: 'Enter',
			code: 'Enter',
			windowsVirtualKeyCode: 13,
			text: String.fromCharCode(13)
		};
		const onSetNote = vi.fn(
			() => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('E_NOTE_SAVE')), ms))
		);
		const { container } = await renderCard(makeItem(), { onSetNote });
		await typeNote(container, 'Call the VSO Monday');
		const save = buttonByText(container, 'Save') as HTMLButtonElement;
		save.focus();
		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		for (let i = 0; i < 15; i++) {
			await new Promise((resolve) => setTimeout(resolve, 40));
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
		}
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await expect.element(page.getByRole('alert')).toHaveTextContent(SAVE_FAILED);
		await new Promise((resolve) => setTimeout(resolve, ms + 50));
		expect(onSetNote).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(save);

		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await vi.waitFor(() => expect(onSetNote).toHaveBeenCalledTimes(2));
	});

	// Cancel would close the editor under a save that may still fail, leaving that failure nowhere to show and the typed
	// text lost, so it is off while the note saves and back on once the save has failed.
	it('Cancel is off while a note saves, and a save that then fails keeps the text and gives Cancel back', async () => {
		let fail: (reason: unknown) => void = () => {};
		const onSetNote = vi
			.fn<(taskId: string, note: string | undefined) => Promise<void>>()
			.mockImplementation(() => new Promise<void>((_, reject) => (fail = reject)));
		const { container } = await renderCard(makeItem(), { onSetNote });
		await typeNote(container, 'Call the VSO Monday');
		const cancel = buttonByText(container, 'Cancel') as HTMLButtonElement;
		expect(cancel.disabled).toBe(false);

		buttonByText(container, 'Save')?.click();
		await expect.poll(() => cancel.disabled).toBe(true);
		expect(onSetNote).toHaveBeenCalledTimes(1);
		cancel.click();
		flushSync();
		expect(container.querySelector('textarea')).not.toBeNull();
		expect(buttonByText(container, 'Save')?.disabled).toBe(false);

		fail(new Error('E_NOTE_SAVE'));
		await expect.element(page.getByRole('alert')).toHaveTextContent(SAVE_FAILED);
		expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
			'Call the VSO Monday'
		);
		await expect.poll(() => cancel.disabled).toBe(false);
		expect(buttonByText(container, 'Cancel')).toBe(cancel);
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

	// A refused date can still be tapped: the browser then moves focus to the field and shows its own reason.
	async function expectRefusedWithReason(
		input: HTMLInputElement,
		go: HTMLButtonElement,
		onSetSnooze: ReturnType<typeof vi.fn>
	): Promise<void> {
		expect(go.disabled).toBe(false);
		go.click();
		await expect.poll(() => document.activeElement).toBe(input);
		expect(input.validationMessage).not.toBe('');
		expect(onSetSnooze).not.toHaveBeenCalled();
	}

	it('refuses an empty date: a tap sets no snooze and the field says why', async () => {
		const onSetSnooze = vi.fn();
		const { input, go } = await openCustomize(onSetSnooze);
		expect(input.required).toBe(true);
		await expectRefusedWithReason(input, go, onSetSnooze);
	});

	// A date the field cannot read (Feb 30, a partly typed date) leaves its value empty, so it is refused as no date.
	it('refuses a date the field cannot read: a tap sets no snooze and the field says why', async () => {
		const onSetSnooze = vi.fn();
		const { input, go, type } = await openCustomize(onSetSnooze);
		type('2027-02-30');
		expect(input.value).toBe('');
		await expectRefusedWithReason(input, go, onSetSnooze);
	});

	it('refuses today: a tap sets no snooze and the field says why', async () => {
		const onSetSnooze = vi.fn();
		const { input, go, type } = await openCustomize(onSetSnooze);
		type(snoozeUntilIso(new Date(), 0));
		await expectRefusedWithReason(input, go, onSetSnooze);
	});

	it('refuses a past date: a tap sets no snooze and the field says why', async () => {
		const onSetSnooze = vi.fn();
		const { input, go, type } = await openCustomize(onSetSnooze);
		type(snoozeUntilIso(new Date(), -3));
		await expectRefusedWithReason(input, go, onSetSnooze);
	});

	// Control: tomorrow, the earliest date allowed, is taken, so the refusals above are not a button that never works.
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
		const { input, go, type } = await openCustomize(onSetSnooze);
		const nextDay = addDays(localTodayIso(evening), 1);
		type(nextDay);
		expect(go.disabled).toBe(false);
		expect(input.validationMessage).toBe('');
		vi.setSystemTime(
			new Date(evening.getFullYear(), evening.getMonth(), evening.getDate() + 1, 0, 1)
		);
		await expectRefusedWithReason(input, go, onSetSnooze);
	});

	it('stops at year 9999: the field says so and a five-digit year is refused', async () => {
		const onSetSnooze = vi.fn();
		const { input, go, type } = await openCustomize(onSetSnooze);
		expect(input.max).toBe(SNOOZE_DATE_MAX);
		type('30000-01-01');
		expect(input.value).toBe('30000-01-01');
		await expectRefusedWithReason(input, go, onSetSnooze);
	});

	// The calendar event of a snoozed task ends the next day, so the latest date is the one whose next day is still in
	// year 9999.
	it('names 9999-12-30 as the latest date', () => {
		expect(SNOOZE_DATE_MAX).toBe('9999-12-30');
	});

	// Control: the latest date allowed is taken, so the refusal below is not a button that never works.
	it('takes 9999-12-30: a tap sets the snooze', async () => {
		const onSetSnooze = vi.fn();
		const { go, type } = await openCustomize(onSetSnooze);
		type('9999-12-30');
		go.click();
		expect(onSetSnooze).toHaveBeenCalledTimes(1);
		expect(onSetSnooze).toHaveBeenCalledWith('skillbridge-hosts', '9999-12-30');
	});

	it('refuses 9999-12-31: a tap sets no snooze and the field says why', async () => {
		const onSetSnooze = vi.fn();
		const { input, go, type } = await openCustomize(onSetSnooze);
		type('9999-12-31');
		await expectRefusedWithReason(input, go, onSetSnooze);
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

	// The dash between the status and the date is drawn by CSS, so with no date it would dangle after the status.
	it('on a phone a status with no date line ends without a dash', async () => {
		await page.viewport(320, 800);
		const { container } = await renderCard(
			makeItem({ status: 'still-to-do', windowEndDate: '2024-06-03', aimLapsed: true })
		);
		const status = container.querySelector('.task-card__status') as HTMLElement;
		expect(getComputedStyle(status, '::after').content).toBe('none');
		const dated = await renderCard(closing);
		const datedStatus = dated.container.querySelector('.task-card__status') as HTMLElement;
		expect(getComputedStyle(datedStatus, '::after').content).toContain('-');
	});

	it('on a wide screen the status line sits beside the title', async () => {
		await page.viewport(1024, 800);
		const { container } = await renderCard(closing);
		const meta = box(container, '.task-card__meta');
		const title = box(container, '.task-card__title');
		expect(meta.top).toBeLessThan(title.bottom);
		expect(meta.left).toBeGreaterThanOrEqual(title.right);
	});

	// Just above the phone breakpoint the status column sits beside the title; a moved date's reason must wrap after
	// the date's comma, or the one-line date takes the width and leaves the title a sliver.
	const moved = makeItem({
		def: firm,
		status: 'closing-soon',
		windowEndDate: '2026-10-31',
		daysLeft: 120,
		fit: { reason: 'terminal-leave', date: '2026-10-31' }
	});

	it('at 481 px a moved date wraps after its comma and leaves the title its room', async () => {
		await page.viewport(481, 800);
		const { container } = await renderCard(moved);
		const meta = box(container, '.task-card__meta');
		// The line wraps (the case under test is reached), the reason starting a line below the date...
		expect(box(container, '.task-card__reason-words').top).toBeGreaterThan(
			box(container, '.task-card__date').top
		);
		// ...the status column still sits beside the title, and the title column is no narrower than it.
		expect(meta.left).toBeGreaterThanOrEqual(box(container, '.task-card__title').right);
		expect(box(container, '.task-card__body').width).toBeGreaterThanOrEqual(meta.width);
	});

	// The column's cap is the wide layout's; on a phone the status line runs the card's full width above the title.
	it("on a phone the status line runs the card's full width, not the column's cap", async () => {
		await page.viewport(320, 800);
		const { container } = await renderCard(moved);
		expect(box(container, '.task-card__meta').width).toBeGreaterThanOrEqual(
			Math.floor(box(container, '.task-card__body').width)
		);
	});

	it('from 481 to 561 px a moved date stays inside the card and the page does not scroll sideways', async () => {
		for (let width = 481; width <= 561; width += 10) {
			await page.viewport(width, 800);
			const { container, unmount } = await renderCard(moved);
			expect(box(container, '.task-card__when').right).toBeLessThanOrEqual(
				box(container, 'article').right
			);
			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
			await unmount();
		}
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

// An editor's own buttons leave the page when it closes, which drops focus to the page; the card hands it back to
// the control that opened the editor - and only when nothing else has taken it since.
describe('TaskCard (focus after an editor closes)', () => {
	type Handlers = {
		onSetStatus: (taskId: string, status: TaskStatus | undefined) => void;
		onSetSnooze: (taskId: string, untilIso: string) => void;
		onSetNote: (taskId: string, note: string | undefined) => Promise<void>;
	};

	// The page re-delivers the item and every handler on each update.
	async function mountCard(item: TimelineItem, overrides: Partial<Handlers> = {}) {
		const handlers: Handlers = {
			onSetStatus: noop,
			onSetSnooze: noop,
			onSetNote: async () => {},
			...overrides
		};
		const view = await render(TaskCard, { props: { item, ...handlers } });
		const update = (next: TimelineItem) => view.rerender({ item: next, ...handlers });
		return { container: view.container, update };
	}

	const press = (container: Element, text: string) => {
		const button = buttonByText(container, text);
		if (!button) throw new Error('E_NO_BUTTON');
		button.click();
		flushSync();
		return button;
	};

	const typeNote = (container: Element, value: string) => {
		const field = container.querySelector('textarea') as HTMLTextAreaElement;
		field.value = value;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	};

	it('returns focus to Snooze when its picker is cancelled', async () => {
		const { container } = await mountCard(makeItem({ status: 'start-now' }));
		const snooze = press(container, 'Snooze');
		press(container, 'Cancel');
		await expect.poll(() => document.activeElement).toBe(snooze);
	});

	it('returns focus to Add note when its editor is cancelled', async () => {
		const { container } = await mountCard(makeItem({ status: 'start-now' }));
		const add = press(container, 'Add note');
		press(container, 'Cancel');
		await expect.poll(() => document.activeElement).toBe(add);
	});

	it('returns focus to Edit note once a saved note lands', async () => {
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item);
		const add = press(container, 'Add note');
		typeNote(container, 'see VSO');
		press(container, 'Save');
		await update({ ...item, note: 'see VSO' });
		await expect.poll(() => document.activeElement).toBe(add);
		expect(add.textContent?.trim()).toBe('Edit note');
	});

	it('returns focus to Add note in the expanded resolved card', async () => {
		const { container } = await mountCard(makeItem({ status: 'done' }));
		(container.querySelector('button.task-line') as HTMLButtonElement).click();
		flushSync();
		const add = press(container, 'Add note');
		press(container, 'Cancel');
		await expect.poll(() => document.activeElement).toBe(add);
	});

	// The two editors can be open together; each gives focus back to its own control.
	it('returns focus to Snooze when its picker is cancelled with the note editor open too', async () => {
		const { container } = await mountCard(makeItem({ status: 'start-now' }));
		const snooze = press(container, 'Snooze');
		press(container, 'Add note');
		(container.querySelector('.task-card__snooze-cancel') as HTMLButtonElement).click();
		flushSync();
		await expect.poll(() => document.activeElement).toBe(snooze);
	});

	it('returns focus to Edit note once a saved note lands with the Snooze picker open too', async () => {
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item);
		const add = press(container, 'Add note');
		press(container, 'Snooze');
		typeNote(container, 'see VSO');
		press(container, 'Save');
		await update({ ...item, note: 'see VSO' });
		await expect.poll(() => document.activeElement).toBe(add);
	});

	it('keeps focus on a resolved task as its line opens and closes', async () => {
		const { container } = await mountCard(makeItem({ status: 'done' }));
		const line = container.querySelector('button.task-line') as HTMLButtonElement;
		line.focus();
		line.click();
		flushSync();
		await expect
			.poll(() => document.activeElement)
			.toBe(container.querySelector('button.task-card__header'));
		const header = document.activeElement as HTMLButtonElement;
		// A pointer click (detail 1): a keyboard-style click (detail 0) this soon after the line handed focus over is the
		// same press and is ignored.
		header.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
		flushSync();
		await expect
			.poll(() => document.activeElement)
			.toBe(container.querySelector('button.task-line'));
	});

	it('returns focus to the collapsed line once a snooze moves the card there', async () => {
		const onSetSnooze = vi.fn();
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item, { onSetSnooze });
		const snooze = press(container, 'Snooze');
		press(container, '1 week');
		expect(onSetSnooze).toHaveBeenCalledTimes(1);
		// The page's update arrives a moment after the tap, once focus is already back on Snooze.
		await expect.poll(() => document.activeElement).toBe(snooze);
		const snoozeUntil = snoozeUntilIso(new Date(), 7);
		await update({ ...item, status: 'snoozed', snoozeUntil });
		await expect
			.poll(() => document.activeElement)
			.toBe(container.querySelector('button.task-line'));
	});

	it.each([
		['Mark done', 'done'],
		['Skip', 'skipped']
	] as const)(
		'returns focus to the collapsed line once %s moves the card there',
		async (label, status) => {
			const onSetStatus = vi.fn();
			const item = makeItem({ status: 'start-now' });
			const { container, update } = await mountCard(item, { onSetStatus });
			(buttonByText(container, label) as HTMLButtonElement).focus();
			press(container, label);
			expect(onSetStatus).toHaveBeenCalledWith(item.def.id, status);
			await update({ ...item, status });
			await expect
				.poll(() => document.activeElement)
				.toBe(container.querySelector('button.task-line'));
		}
	);

	it('returns focus to the open card once Restore moves it there', async () => {
		const onSetStatus = vi.fn();
		const item = makeItem({ status: 'done' });
		const { container, update } = await mountCard(item, { onSetStatus });
		(container.querySelector('button.task-line') as HTMLButtonElement).click();
		flushSync();
		(buttonByText(container, 'Restore') as HTMLButtonElement).focus();
		press(container, 'Restore');
		expect(onSetStatus).toHaveBeenCalledWith(item.def.id, undefined);
		await update({ ...item, status: 'start-now' });
		await expect
			.poll(() => document.activeElement)
			.toBe(container.querySelector('article.task-card'));
	});

	// Checked on a failed save, where the editor and its Save stay on the page once the save settles.
	it('marks the note Save busy while its save runs, and not after', async () => {
		let fail: () => void = noop;
		const pending = new Promise<void>((_, reject) => {
			fail = () => reject(new Error('E_TEST_NOTE'));
		});
		const { container } = await mountCard(makeItem({ status: 'start-now' }), {
			onSetNote: () => pending
		});
		press(container, 'Add note');
		typeNote(container, 'see VSO');
		const save = buttonByText(container, 'Save') as HTMLButtonElement;
		expect(save.getAttribute('aria-busy')).toBe('false');
		press(container, 'Save');
		await expect.poll(() => save.getAttribute('aria-busy')).toBe('true');
		fail();
		await expect.poll(() => container.querySelector('.task-card__note-error')).not.toBeNull();
		expect(save.isConnected).toBe(true);
		expect(save.getAttribute('aria-busy')).toBe('false');
	});

	it('leaves focus alone when the person has moved on before a save lands', async () => {
		let land: () => void = noop;
		const pending = new Promise<void>((resolve) => {
			land = resolve;
		});
		const { container } = await mountCard(makeItem({ status: 'start-now' }), {
			onSetNote: () => pending
		});
		press(container, 'Add note');
		typeNote(container, 'see VSO');
		press(container, 'Save');
		const done = buttonByText(container, 'Mark done') as HTMLButtonElement;
		done.focus();
		land();
		await pending;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.activeElement).toBe(done);
	});

	it('returns focus to the collapsed line once a custom-date snooze moves the card there', async () => {
		const onSetSnooze = vi.fn();
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item, { onSetSnooze });
		const snooze = press(container, 'Snooze');
		press(container, 'Customize');
		const until = snoozeUntilIso(new Date(), 10);
		const field = container.querySelector('input[type="date"]') as HTMLInputElement;
		field.value = until;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		(container.querySelector('.task-card__snooze-go') as HTMLButtonElement).click();
		flushSync();
		expect(onSetSnooze).toHaveBeenCalledWith(item.def.id, until);
		await expect.poll(() => document.activeElement).toBe(snooze);
		await update({ ...item, status: 'snoozed', snoozeUntil: until });
		await expect
			.poll(() => document.activeElement)
			.toBe(container.querySelector('button.task-line'));
	});

	it('takes no focus from a later change elsewhere once its own change has landed', async () => {
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item);
		(buttonByText(container, 'Mark done') as HTMLButtonElement).focus();
		press(container, 'Mark done');
		await update({ ...item, status: 'done' });
		await expect
			.poll(() => document.activeElement)
			.toBe(container.querySelector('button.task-line'));
		(document.activeElement as HTMLElement).blur();
		await update({ ...item, status: 'start-now' });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.activeElement).toBe(document.body);
	});

	// A write the page could not land changes nothing here, so a later change from elsewhere is not this card's.
	it('takes no focus later when a change made on the card did not land', async () => {
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item, { onSetStatus: async () => false });
		press(container, 'Mark done');
		await new Promise((resolve) => setTimeout(resolve, 50));
		(document.activeElement as HTMLElement | null)?.blur();
		await update({ ...item, status: 'skipped' });
		expect(container.querySelector('button.task-line')).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.activeElement).toBe(document.body);
	});

	it('takes no focus when the status changes elsewhere', async () => {
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item);
		(document.activeElement as HTMLElement | null)?.blur();
		expect(document.activeElement).toBe(document.body);
		await update({ ...item, status: 'done' });
		expect(container.querySelector('button.task-line')).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.activeElement).toBe(document.body);
	});

	// A change from another tab closes the open picker; a person who was inside it keeps their place.
	it('returns focus to Snooze when a change elsewhere closes the picker and the card stays open', async () => {
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item);
		const snooze = press(container, 'Snooze');
		const preset = buttonByText(container, '1 week') as HTMLButtonElement;
		preset.focus();
		expect(document.activeElement).toBe(preset);
		await update({ ...item, status: 'still-to-do' });
		expect(container.querySelector('.task-card__snooze')).toBeNull();
		await expect.poll(() => document.activeElement).toBe(snooze);
	});

	it('returns focus to the card when the change elsewhere also removes Snooze', async () => {
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item);
		press(container, 'Snooze');
		(buttonByText(container, '1 week') as HTMLButtonElement).focus();
		await update({ ...item, status: 'closing-soon' });
		expect(buttonByText(container, 'Snooze')).toBeUndefined();
		await expect
			.poll(() => document.activeElement)
			.toBe(container.querySelector('article.task-card'));
	});

	it('returns focus to the collapsed line when a change elsewhere resolves the card', async () => {
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item);
		press(container, 'Snooze');
		(buttonByText(container, '1 week') as HTMLButtonElement).focus();
		await update({ ...item, status: 'done' });
		await expect
			.poll(() => document.activeElement)
			.toBe(container.querySelector('button.task-line'));
	});

	it('leaves focus alone when a change elsewhere closes the picker and focus is outside it', async () => {
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item);
		press(container, 'Snooze');
		const note = buttonByText(container, 'Add note') as HTMLButtonElement;
		note.focus();
		await update({ ...item, status: 'still-to-do' });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.activeElement).toBe(note);
	});

	it('takes no focus from a change elsewhere when the picker is open but nothing in it held focus', async () => {
		const item = makeItem({ status: 'start-now' });
		const { container, update } = await mountCard(item);
		press(container, 'Snooze');
		(document.activeElement as HTMLElement | null)?.blur();
		expect(document.activeElement).toBe(document.body);
		await update({ ...item, status: 'still-to-do' });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.activeElement).toBe(document.body);
	});

	describe('Enter on the collapsed line', () => {
		// Enter as a keyboard sends it: the key, its code and the carriage return it types.
		const ENTER = {
			key: 'Enter',
			code: 'Enter',
			windowsVirtualKeyCode: 13,
			text: String.fromCharCode(13)
		};
		const GUARD_WAIT_MS = 600;
		const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

		// Mark done resolves after `ms` (a timer even at 0, as a real write is never synchronous); the page then delivers
		// the done task.
		async function mountSlowDone(ms: number) {
			const item = makeItem({ status: 'start-now' });
			let deliver: (next: TimelineItem) => Promise<void> = async () => {};
			const view = await mountCard(item, {
				onSetStatus: async () => {
					await wait(ms);
					await deliver({ ...item, status: 'done' });
				}
			});
			deliver = view.update;
			return view;
		}

		const key = (type: 'keyDown' | 'keyUp', autoRepeat = false) =>
			cdp().send('Input.dispatchKeyEvent', { type, autoRepeat, ...ENTER });

		// A held key repeats about every 40 ms; Mark done hands focus to the line it collapses to, so the repeats that follow
		// land on the line and must not open it.
		it.each([
			['at once', 0],
			['after a while', 100]
		] as const)(
			'is not opened by a held Enter on Mark done when the write lands %s',
			async (_, ms) => {
				const { container } = await mountSlowDone(ms);
				// Each repeat that opened the line would be undone by the next one (the header closes it again), so the end
				// state alone hides it: count the times the opened card appears.
				let opened = 0;
				const watch = new MutationObserver(() => {
					if (container.querySelector('button.task-card__header')) opened++;
				});
				watch.observe(container, { childList: true, subtree: true });
				(buttonByText(container, 'Mark done') as HTMLButtonElement).focus();
				await key('keyDown');
				for (let i = 0; i < 15; i++) {
					await wait(40);
					await key('keyDown', true);
				}
				await key('keyUp');
				watch.disconnect();
				expect(opened).toBe(0);
				const line = container.querySelector('button.task-line');
				expect(line).not.toBeNull();
				expect(line?.getAttribute('aria-expanded')).toBe('false');
				expect(container.querySelector('button.task-card__header')).toBeNull();
				expect(document.activeElement).toBe(line);
			}
		);

		it('is not opened by a second Enter just after it took focus, but is opened by one later', async () => {
			// The guard reads the clock, and on a slow machine the test browser's own delays can push a real 300 ms past it.
			// Only Date is faked, so the time the guard sees between the hand-off and each key is exactly what is set here.
			vi.useFakeTimers({ toFake: ['Date'] });
			try {
				const { container } = await mountSlowDone(0);
				(buttonByText(container, 'Mark done') as HTMLButtonElement).focus();
				await key('keyDown');
				await key('keyUp');
				await expect
					.poll(() => document.activeElement)
					.toBe(container.querySelector('button.task-line'));
				// Well inside the guard but long after a press could be the same one.
				vi.setSystemTime(Date.now() + 300);
				await key('keyDown');
				await key('keyUp');
				await wait(50);
				expect(container.querySelector('button.task-card__header')).toBeNull();
				expect(container.querySelector('button.task-line')).not.toBeNull();

				vi.setSystemTime(Date.now() + GUARD_WAIT_MS);
				await key('keyDown');
				await key('keyUp');
				await expect.poll(() => container.querySelector('button.task-card__header')).not.toBeNull();
			} finally {
				vi.useRealTimers();
			}
		});

		// The line hands focus to the card's header as it opens, so the rest of the same press (a held key's repeats, or a
		// quick second press) lands on the header and must not close it again.
		it('stays open for a held Enter on the line of a done task', async () => {
			const { container } = await mountCard(makeItem({ status: 'done' }));
			// Each repeat that closed the card would be undone by the next one, so the end state alone hides it: count the
			// times the collapsed line comes back.
			let closed = 0;
			const watch = new MutationObserver(() => {
				if (container.querySelector('button.task-line')) closed++;
			});
			(container.querySelector('button.task-line') as HTMLButtonElement).focus();
			watch.observe(container, { childList: true, subtree: true });
			await key('keyDown');
			for (let i = 0; i < 15; i++) {
				await wait(40);
				await key('keyDown', true);
			}
			await key('keyUp');
			watch.disconnect();
			expect(closed).toBe(0);
			const header = container.querySelector('button.task-card__header');
			expect(header).not.toBeNull();
			expect(container.querySelector('button.task-line')).toBeNull();
			expect(document.activeElement).toBe(header);
		});

		it('stays open for a second Enter just after the line opened', async () => {
			const { container } = await mountCard(makeItem({ status: 'done' }));
			(container.querySelector('button.task-line') as HTMLButtonElement).focus();
			await key('keyDown');
			await key('keyUp');
			await expect.poll(() => container.querySelector('button.task-card__header')).not.toBeNull();
			await wait(50);
			await key('keyDown');
			await key('keyUp');
			await wait(50);
			expect(container.querySelector('button.task-card__header')).not.toBeNull();
			expect(container.querySelector('button.task-line')).toBeNull();
		});

		// The header hands focus back to the line as it closes, so a second press right after must not open it again.
		it('stays closed for a second Enter just after the header closed the card', async () => {
			const { container } = await mountCard(makeItem({ status: 'done' }));
			(container.querySelector('button.task-line') as HTMLButtonElement).focus();
			await key('keyDown');
			await key('keyUp');
			await expect.poll(() => container.querySelector('button.task-card__header')).not.toBeNull();
			await wait(GUARD_WAIT_MS);
			await key('keyDown');
			await key('keyUp');
			await expect.poll(() => container.querySelector('button.task-line')).not.toBeNull();
			// A keyboard close hands focus to the line; without it the second Enter below would test nothing.
			await expect
				.poll(() => document.activeElement)
				.toBe(container.querySelector('button.task-line'));
			await key('keyDown');
			await key('keyUp');
			await wait(50);
			expect(container.querySelector('button.task-line')).not.toBeNull();
			expect(container.querySelector('button.task-card__header')).toBeNull();
		});

		it('is opened by a mouse click just after it took focus', async () => {
			const { container } = await mountSlowDone(0);
			(buttonByText(container, 'Mark done') as HTMLButtonElement).focus();
			await key('keyDown');
			await key('keyUp');
			await expect
				.poll(() => document.activeElement)
				.toBe(container.querySelector('button.task-line'));
			await page.getByRole('button', { name: /Research SkillBridge hosts/ }).click();
			await expect.poll(() => container.querySelector('button.task-card__header')).not.toBeNull();
		});
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

describe('the TAP guides a task opens in the app', () => {
	const tsp = TASK_DEFS.find((t) => t.id === 'tsp-decision');
	const sgli = TASK_DEFS.find((t) => t.id === 'update-sgli');
	const GUIDE = 'TAP - Financial Planning for Transition';

	it('lists the guide first, counted with the links, and opens it in the app on a press', async () => {
		if (!tsp) throw new Error('E_TEST_TASK_MISSING');
		const onOpenGuide = vi.fn();
		const { container } = await render(TaskCard, {
			props: { item: makeItem({ def: tsp }), onSetStatus: noop, onSetSnooze: noop, onOpenGuide }
		});
		await page.getByRole('button', { name: /^Related resources \(2\)/ }).click();
		const items = container.querySelectorAll('.task-card__related-list li');
		expect(items).toHaveLength(2);
		const guide = items[0]?.querySelector('button');
		expect(guide?.textContent?.trim()).toBe(`Read in the app: ${GUIDE}`);
		expect(items[0]?.textContent).toContain('Works offline once saved');
		expect(items[1]?.querySelector('a')?.getAttribute('target')).toBe('_blank');
		await page.getByRole('button', { name: `Read in the app: ${GUIDE}` }).click();
		expect(onOpenGuide).toHaveBeenCalledExactlyOnceWith('tap_financial_planning', GUIDE);
	});

	// A claim task's guide is VA's own: its entry reads as a document to read, never as help with a claim.
	it('makes no personal claim on a claim task with its guide open', async () => {
		const bdd = TASK_DEFS.find((t) => t.id === 'va-bdd-claim');
		if (!bdd) throw new Error('E_TEST_TASK_MISSING');
		const { container } = await render(TaskCard, {
			props: {
				item: makeItem({ def: bdd }),
				onSetStatus: noop,
				onSetSnooze: noop,
				onOpenGuide: noop
			}
		});
		await page.getByRole('button', { name: /^Related resources/ }).click();
		expect(container.textContent).toContain('Read in the app: TAP - VA Disability Compensation');
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);
	});

	// The app's tap rule: a guide entry is a 44 px target even when its title fits on one line.
	it('gives each guide entry a 44 px tap area', async () => {
		if (!tsp) throw new Error('E_TEST_TASK_MISSING');
		const { container } = await render(TaskCard, {
			props: {
				item: makeItem({ def: tsp }),
				onSetStatus: noop,
				onSetSnooze: noop,
				onOpenGuide: noop
			}
		});
		await page.getByRole('button', { name: /^Related resources/ }).click();
		const guide = container.querySelector('.task-card__guide') as HTMLButtonElement;
		expect(guide.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
	});

	// Forced colours draw a button in ButtonText and a link in LinkText; the guide entry reads as one of the links, so it
	// keeps the links' colour there too.
	it('draws a guide entry in the link colour under forced colours', async () => {
		if (!tsp) throw new Error('E_TEST_TASK_MISSING');
		const { container } = await render(TaskCard, {
			props: {
				item: makeItem({ def: tsp }),
				onSetStatus: noop,
				onSetSnooze: noop,
				onOpenGuide: noop
			}
		});
		await page.getByRole('button', { name: /^Related resources/ }).click();
		const guide = container.querySelector('.task-card__guide') as HTMLButtonElement;
		const link = container.querySelector('.task-card__related-list a') as HTMLAnchorElement;
		const session = cdp();
		await session.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'forced-colors', value: 'active' }]
		});
		try {
			await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(true);
			expect(getComputedStyle(guide).color).toBe(getComputedStyle(link).color);
		} finally {
			await session.send('Emulation.setEmulatedMedia', {
				features: [{ name: 'forced-colors', value: 'none' }]
			});
		}
		await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(false);
	});

	it('shows the list for a task whose only entry is a guide', async () => {
		if (!sgli) throw new Error('E_TEST_TASK_MISSING');
		const { container } = await render(TaskCard, {
			props: {
				item: makeItem({ def: sgli }),
				onSetStatus: noop,
				onSetSnooze: noop,
				onOpenGuide: noop
			}
		});
		await page.getByRole('button', { name: /^Related resources \(1\)/ }).click();
		expect(container.querySelector('.task-card__related-list button')?.textContent?.trim()).toBe(
			'Read in the app: TAP - VA Life Insurance Benefits (Resource Guide)'
		);
	});

	it('offers no guide where nothing can open it', async () => {
		if (!sgli || !tsp) throw new Error('E_TEST_TASK_MISSING');
		const { container } = await render(TaskCard, {
			props: { item: makeItem({ def: sgli }), onSetStatus: noop, onSetSnooze: noop }
		});
		expect(page.getByRole('button', { name: /^Related resources/ }).elements()).toHaveLength(0);
		const other = await render(TaskCard, {
			props: { item: makeItem({ def: tsp }), onSetStatus: noop, onSetSnooze: noop }
		});
		await page.getByRole('button', { name: /^Related resources \(1\)/ }).click();
		expect(other.container.querySelector('.task-card__related-list button')).toBeNull();
		expect(container.textContent).not.toContain('Read in the app');
	});
});
