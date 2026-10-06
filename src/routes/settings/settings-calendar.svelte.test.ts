import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';

// Days from the real clock: the page builds its calendar from today, and the file never carries a past event.
const { isoFromToday } = vi.hoisted(() => ({
	isoFromToday: (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
}));

// The page reads the app's state from the layout's context. Here the profile is unlocked with a separation date, the
// calendar store has loaded a record of one event the file no longer holds, and the timeline store has not loaded,
// so the stored done, skip and snooze marks are still unknown.
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		store: {
			locked: false,
			clockBackward: false,
			persona: { completeness: 'eaos-only', eaos: isoFromToday(200), daysUntilSeparation: 200 }
		},
		timeline: { ready: false, state: { schemaVersion: 1, tasks: {} } },
		calendar: {
			ready: true,
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
		},
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

describe('Settings, the calendar add', () => {
	// Until the timeline store loads, both the file and the out-of-date list would be built from a stand-in empty
	// task state: the add could carry a task the user marked done, and the list could name an event that is not out
	// of date.
	it('waits for the timeline store as well as the calendar store', async () => {
		const { container } = render(SettingsPage);
		await expect
			.element(page.getByText(/could not be loaded, so adding is unavailable right now/))
			.toBeVisible();
		await expect
			.element(page.getByRole('button', { name: /^add to my calendar$/i }))
			.toBeDisabled();
		expect(container.textContent).not.toContain('Your calendar is out of date');
	});
});
