import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';
import { resolve } from '$app/paths';

// Days from the real clock: the page builds its calendar from today, and the file never carries a past event.
const { isoFromToday, timeline, calendar } = vi.hoisted(() => {
	const isoFromToday = (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	};
	return {
		isoFromToday,
		// What the page reads from each store; the cases move the flags, beforeEach puts them back.
		timeline: {
			ready: false,
			failed: false,
			locked: false,
			state: { schemaVersion: 1, tasks: {} },
			setStatus: () => Promise.resolve(),
			setSnooze: () => Promise.resolve(),
			refresh: () => Promise.resolve(),
			load: (): Promise<void> => Promise.resolve()
		},
		calendar: {
			ready: true,
			failed: false,
			locked: false,
			load: (): Promise<void> => Promise.resolve(),
			exclusions: { taskIds: [], categories: [] },
			lastAdd: [
				{
					taskId: 'tap-capstone',
					moment: 'last',
					title: 'Last day: an older title',
					isoDate: isoFromToday(30),
					addedOn: isoFromToday(-5)
				}
			]
		}
	};
});

// The page reads the app's state from the layout's context. Here the profile is unlocked with a separation date, the
// calendar store has loaded a record of one event the file no longer holds, and the timeline store has not loaded,
// so the stored done, skip and snooze marks are still unknown.
// Reactive, unlike the store flags above: Unlock opens the profile, and the page swaps its locked panel for the
// sections at that moment.
const profile = $state({ locked: false });
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		store: {
			get locked() {
				return profile.locked;
			},
			load: async () => {
				profile.locked = false;
			},
			clockBackward: false,
			persona: { completeness: 'eaos-only', eaos: isoFromToday(200), daysUntilSeparation: 200 }
		},
		timeline,
		calendar,
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

const CALENDAR_LINE =
	'Your calendar settings could not be loaded, so adding is unavailable right now. Reload the app to try again.';
const PROGRESS_LINE =
	'Your saved progress could not be loaded, so adding is unavailable right now. Reload the app to try again.';
const LOCKED_LINE =
	'Your timeline is locked, so adding is unavailable right now. Unlock it on the Timeline page.';

beforeEach(() => {
	timeline.ready = false;
	timeline.failed = false;
	timeline.locked = false;
	calendar.ready = true;
	calendar.failed = false;
	calendar.locked = false;
	timeline.load = () => Promise.resolve();
	calendar.load = () => Promise.resolve();
	profile.locked = false;
});

const customizeSummary = () => page.getByRole('button', { name: /^customize what's included/i });

describe('Settings, the calendar add', () => {
	// Until the timeline store loads, both the file and the out-of-date list would be built from a stand-in empty
	// task state: the add could carry a task the user marked done, and the list could name an event that is not out
	// of date. A read that is still running is not a failure, so the panel says nothing about one.
	it('waits for the timeline store as well as the calendar store', async () => {
		const { container } = await render(SettingsPage);
		await expect
			.element(page.getByRole('button', { name: /^add to my calendar$/i }))
			.toBeDisabled();
		await expect.element(customizeSummary()).toMatchTextContent('Loading');
		expect(container.textContent).not.toContain('could not be loaded, so adding is unavailable');
		expect(container.textContent).not.toContain('Your calendar is out of date');
		expect(container.textContent).toContain(
			'Changed a date? Remove the events you added before, then add again.'
		);
	});

	it('says the saved progress could not be loaded when the timeline failed to read', async () => {
		timeline.failed = true;
		await render(SettingsPage);
		await expect.element(page.getByText(PROGRESS_LINE)).toBeVisible();
		await expect
			.element(page.getByRole('button', { name: /^add to my calendar$/i }))
			.toBeDisabled();
		await expect.element(customizeSummary()).toMatchTextContent('Unavailable');
	});

	it('says the timeline is locked, with a link to the Timeline page, when it is', async () => {
		timeline.locked = true;
		await render(SettingsPage);
		await expect.element(page.getByText(LOCKED_LINE)).toBeVisible();
		await expect
			.element(page.getByText(LOCKED_LINE).getByRole('link', { name: 'Timeline' }))
			.toHaveAttribute('href', resolve('/timeline'));
		await expect.element(customizeSummary()).toMatchTextContent('Locked');
	});

	it('says the calendar settings could not be loaded when that store failed to read', async () => {
		timeline.ready = true;
		calendar.ready = false;
		calendar.failed = true;
		await render(SettingsPage);
		await expect.element(page.getByText(CALENDAR_LINE)).toBeVisible();
		expect(page.getByText(PROGRESS_LINE).query()).toBeNull();
		await expect.element(customizeSummary()).toMatchTextContent('Unavailable');
	});

	// Unlock reads the timeline, then the calendar; a page hidden during the second read leaves the calendar locked, and
	// nothing re-reads a locked store, so the panel gives today's line instead of waiting on a read that is not coming.
	it('says the calendar settings could not be loaded when that store was left locked', async () => {
		timeline.ready = true;
		calendar.ready = false;
		calendar.locked = true;
		await render(SettingsPage);
		await expect.element(page.getByText(CALENDAR_LINE)).toBeVisible();
		await expect.element(customizeSummary()).toMatchTextContent('Unavailable');
	});

	// Both stores stay locked until their own read lands, so while Unlock reads them the page would flash the lock line
	// and then today's failure line before settling. It says loading for the whole read, then follows the stores.
	it('reads loading, not a lock or a failure, while its own Unlock reads the stores', async () => {
		profile.locked = true;
		timeline.locked = true;
		calendar.ready = false;
		calendar.locked = true;
		let finish = () => {};
		const reading = new Promise<void>((resolve) => (finish = resolve));
		timeline.load = () => reading;
		calendar.load = () => reading;
		await render(SettingsPage);

		await page.getByRole('button', { name: 'Unlock' }).click();
		await expect.element(customizeSummary()).toMatchTextContent('Loading');
		expect(page.getByText(LOCKED_LINE).query()).toBeNull();
		expect(page.getByText(CALENDAR_LINE).query()).toBeNull();
		expect(page.getByText(PROGRESS_LINE).query()).toBeNull();

		timeline.ready = true;
		timeline.locked = false;
		calendar.ready = true;
		calendar.locked = false;
		finish();
		await expect.element(customizeSummary()).toMatchTextContent('All included');
		expect(page.getByText(CALENDAR_LINE).query()).toBeNull();
	});
});
