import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import TimelinePage from './+page.svelte';
import type { CalendarFile } from '$lib/calendar/build-ics';
import { TASK_DEFS } from '$lib/timeline';
import { addDays, localTodayIso } from '$lib/timeline/day-math';
import { formatTimelineDate } from '$lib/timeline/format-date';
import { LAST_ASK_DAYS } from '$lib/timeline/skillbridge-plan';

const { current, handOver } = vi.hoisted(() => ({
	handOver: vi.fn<(file: CalendarFile) => Promise<void>>(async () => {}),
	// The separation date, set by each test from the day it starts on.
	current: { eaos: '' }
}));

vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		store: {
			locked: false,
			clockBackward: false,
			persona: { completeness: 'eaos-only', eaos: current.eaos, daysUntilSeparation: 0 }
		},
		timeline: { ready: true, failed: false, state: { schemaVersion: 1, tasks: {} } },
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
