import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import TimelinePage from './+page.svelte';
import type { CalendarFile } from '$lib/calendar/build-ics';
import { TASK_DEFS } from '$lib/timeline';
import { addDays, localTodayIso } from '$lib/timeline/day-math';
import { formatTimelineDate } from '$lib/timeline/format-date';
import { JUST_CLOSED_DAYS } from '$lib/timeline/generate';
import { LAST_ASK_DAYS } from '$lib/timeline/skillbridge-plan';

const { current, handOver } = vi.hoisted(() => ({
	handOver: vi.fn<(file: CalendarFile) => Promise<void>>(async () => {}),
	// The separation date and the saved task states, set by each test from the day it starts on.
	current: { eaos: '', tasks: {} as Record<string, { status: 'done' | 'skipped' }> }
}));

vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		// Read at each use, so a test can relock the profile: a locked one reads as no persona.
		store: {
			get locked() {
				return lock.locked;
			},
			clockBackward: false,
			get persona() {
				return lock.locked
					? { completeness: 'none' }
					: { completeness: 'eaos-only', eaos: current.eaos, daysUntilSeparation: 0 };
			}
		},
		timeline: { ready: true, failed: false, state: { schemaVersion: 1, tasks: current.tasks } },
		calendar: {
			ready: true,
			exclusions: { taskIds: [], categories: [] },
			card: {},
			dismissCard: async () => {}
		},
		byok: null,
		cause: null,
		wipeAll: null,
		relockAll: null
	}),
	setProfileApp: () => {}
}));

// Whether the profile is locked; reactive, so the page re-derives when a test relocks it.
const lock = $state({ locked: false });

// The page's own hand-over of the calendar file would start a real download.
vi.mock('$lib/calendar/hand-over', () => ({ handOver }));

// A soft task with a recommended day and a later window end: on its recommended day it is aimed for that day, and once
// that day has passed the view aims for the window end.
const SOFT = TASK_DEFS.find((d) => d.id === 'va-gov-account');
if (!SOFT || SOFT.kind !== 'soft' || SOFT.recommendedOffset === undefined)
	throw new Error('E_TEST');
const RECOMMENDED = SOFT.recommendedOffset;
const WINDOW_END = SOFT.windowEnd;

const SECONDS_BEFORE_MIDNIGHT = 10;

afterEach(() => {
	vi.useRealTimers();
	handOver.mockReset();
	current.tasks = {};
	lock.locked = false;
});

// The clock stopped ten seconds before local midnight; the separation date puts the soft task's recommended day on
// today. Returns today, tomorrow and the window end the re-derived view dates the task at.
function startBeforeMidnight(): { today: string; tomorrow: string; windowEnd: string } {
	vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
	const start = new Date();
	start.setHours(23, 59, 60 - SECONDS_BEFORE_MIDNIGHT, 0);
	vi.setSystemTime(start);
	const today = localTodayIso(new Date());
	current.eaos = addDays(today, -RECOMMENDED);
	return { today, tomorrow: addDays(today, 1), windowEnd: addDays(current.eaos, WINDOW_END) };
}

async function passMidnight(): Promise<void> {
	vi.advanceTimersByTime(SECONDS_BEFORE_MIDNIGHT * 1000);
	await tick();
}

describe('Timeline, a page left open past midnight', () => {
	it('moves the Today marker to the new day', async () => {
		const { today, tomorrow } = startBeforeMidnight();
		const { container } = await render(TimelinePage);
		const pill = () => container.querySelector('.timeline-today__pill')?.textContent ?? '';
		expect(pill()).toContain(`Today - ${formatTimelineDate(today)}`);

		await passMidnight();
		expect(pill()).toContain(`Today - ${formatTimelineDate(tomorrow)}`);
	});

	// The view dated the task at the old today; the file is built at the new one and drops every day before it, so a view
	// that stayed on the old day would hand over a file without the event the card was offered for.
	it('keeps the Aim for event of a task aimed for the old today in the calendar file', async () => {
		const { windowEnd } = startBeforeMidnight();
		await render(TimelinePage);
		await passMidnight();

		const sent = new Promise<CalendarFile>((resolve) => {
			handOver.mockImplementationOnce(async (file) => resolve(file));
		});
		(page.getByRole('button', { name: 'Add to my calendar' }).element() as HTMLElement).click();
		const file = await sent;

		expect(file.events.find((e) => e.taskId === SOFT.id)).toMatchObject({
			moment: 'aim',
			isoDate: windowEnd
		});
		expect(file.ics).toContain(`SUMMARY:Aim for: ${SOFT.title}`);
	});

	// The question stops being asked from three weeks before separation. With separation a day past that line, the
	// question is up on the old day and gone on the new one.
	it('takes the SkillBridge question away on the day it stops being asked', async () => {
		const { today } = startBeforeMidnight();
		current.eaos = addDays(today, LAST_ASK_DAYS + 1);
		const { container } = await render(TimelinePage);
		expect(container.querySelectorAll('.sb-card')).toHaveLength(1);

		await passMidnight();
		expect(container.querySelectorAll('.sb-card')).toHaveLength(0);
	});
});

// The day turning can take away the card that holds focus. The BDD claim is a task that closes for good at its last day
// (it is neither soft nor required), so it is "just closed" for JUST_CLOSED_DAYS after that day and its phase stays open.
const CLOSING = TASK_DEFS.find((d) => d.id === 'va-bdd-claim');
if (!CLOSING || CLOSING.kind !== 'closes') throw new Error('E_TEST');
const CLOSING_ID = CLOSING.id;
const CLOSING_WINDOW_END = CLOSING.windowEnd;

describe('Timeline, focus when the day turns at midnight', () => {
	// Every task done except the closing one, whose last day was JUST_CLOSED_DAYS days before today: its phase is open
	// today and folds on the next day. The SkillBridge question is answered, so it is not on the page.
	function startWithJustClosedTask(): void {
		const { today } = startBeforeMidnight();
		current.eaos = addDays(today, -JUST_CLOSED_DAYS - CLOSING_WINDOW_END);
		current.tasks = {
			...Object.fromEntries(
				TASK_DEFS.filter((d) => d.id !== CLOSING_ID).map((d) => [d.id, { status: 'done' as const }])
			),
			'skillbridge-plan': { status: 'skipped' }
		};
	}

	const phaseToggle = (container: HTMLElement) =>
		container.querySelector<HTMLElement>('[id="6-3mo"] .timeline-list__toggle');

	it('hands focus on when the phase folds under the card that holds it', async () => {
		startWithJustClosedTask();
		const { container } = await render(TimelinePage);
		const card = container.querySelector<HTMLElement>(`#task-${CLOSING_ID}`);
		expect(card).not.toBeNull();
		expect(phaseToggle(container)).toBeNull();
		card?.focus();
		expect(document.activeElement).toBe(card);

		await passMidnight();
		await expect.poll(() => phaseToggle(container)?.getAttribute('aria-expanded')).toBe('false');
		expect(container.querySelector(`#task-${CLOSING_ID}`)).toBeNull();
		// No calendar card and no task card is left on the page, so the first phase toggle comes next.
		const next = container.querySelector<HTMLElement>('.timeline-list__toggle');
		expect(next).not.toBeNull();
		await expect.poll(() => document.activeElement).toBe(next);
	});

	it('hands focus on when the SkillBridge question goes under its answer button', async () => {
		const { today } = startBeforeMidnight();
		current.eaos = addDays(today, LAST_ASK_DAYS + 1);
		const { container } = await render(TimelinePage);
		const yes = page.getByRole('button', { name: 'Yes' }).element() as HTMLElement;
		yes.focus();
		expect(document.activeElement).toBe(yes);

		await passMidnight();
		await expect.poll(() => container.querySelectorAll('.sb-card').length).toBe(0);
		const next = container.querySelector<HTMLElement>('.cal-card__add');
		expect(next).not.toBeNull();
		await expect.poll(() => document.activeElement).toBe(next);
	});

	it('leaves focus on the page body when nothing held it', async () => {
		startWithJustClosedTask();
		const { container } = await render(TimelinePage);
		expect(container.querySelector(`#task-${CLOSING_ID}`)).not.toBeNull();
		expect(document.activeElement).toBe(document.body);

		await passMidnight();
		await expect.poll(() => phaseToggle(container)?.getAttribute('aria-expanded')).toBe('false');
		// Let any move of focus after the update land before looking.
		await tick();
		await tick();
		expect(document.activeElement).toBe(document.body);
	});

	// A relock takes the list away as well (a locked profile has no view), and the focus a card held is handed on the
	// same way: to the page heading, the one thing left to land on.
	it('hands focus on when a relock takes the list away', async () => {
		startWithJustClosedTask();
		const { container } = await render(TimelinePage);
		const card = container.querySelector<HTMLElement>(`#task-${CLOSING_ID}`);
		expect(card).not.toBeNull();
		card?.focus();
		expect(document.activeElement).toBe(card);

		lock.locked = true;
		await expect.poll(() => container.querySelector(`#task-${CLOSING_ID}`)).toBeNull();
		const heading = container.querySelector<HTMLElement>('h1');
		expect(heading).not.toBeNull();
		await expect.poll(() => document.activeElement).toBe(heading);
	});
});
