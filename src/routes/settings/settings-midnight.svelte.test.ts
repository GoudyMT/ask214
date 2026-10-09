import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';
import type { CalendarFile } from '$lib/calendar/build-ics';
import { TASK_DEFS } from '$lib/timeline';
import { addDays, localTodayIso } from '$lib/timeline/day-math';

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
		timeline: { ready: true, failed: false, locked: false, state: { schemaVersion: 1, tasks: {} } },
		calendar: { ready: true, exclusions: { taskIds: [], categories: [] }, lastAdd: [] },
		byok: null,
		cause: null,
		wipeAll: null,
		relockAll: null
	}),
	setProfileApp: () => {}
}));
vi.mock('$lib/install/context', () => ({
	getInstallApp: () => ({
		canPrompt: false,
		installed: true,
		ios: false,
		persisted: true,
		promptInstall: async () => 'dismissed'
	}),
	setInstallApp: () => {}
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

describe('Settings, a page left open past midnight', () => {
	// The panel's items were dated at the old today; the file is built at the new one and drops every day before it, so
	// items that stayed on the old day would hand over a file without the event the panel offered.
	it('keeps the Aim for event of a task aimed for the old today in the calendar file', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
		const start = new Date();
		start.setHours(23, 59, 60 - SECONDS_BEFORE_MIDNIGHT, 0);
		vi.setSystemTime(start);
		current.eaos = addDays(localTodayIso(new Date()), -RECOMMENDED);
		const windowEnd = addDays(current.eaos, WINDOW_END);

		await render(SettingsPage);
		vi.advanceTimersByTime(SECONDS_BEFORE_MIDNIGHT * 1000);
		await tick();

		const sent = new Promise<CalendarFile>((resolve) => {
			handOver.mockImplementationOnce(async (file) => resolve(file));
		});
		(page.getByRole('button', { name: /^add to my calendar$/i }).element() as HTMLElement).click();
		const file = await sent;

		expect(file.events.find((e) => e.taskId === SOFT.id)).toMatchObject({
			moment: 'aim',
			isoDate: windowEnd
		});
		expect(file.ics).toContain(`SUMMARY:Aim for: ${SOFT.title}`);
	});
});
