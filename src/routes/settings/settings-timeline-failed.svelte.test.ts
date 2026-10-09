import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';

// Days from the real clock: the page builds its calendar from today, and the file never carries a past event.
const { isoFromToday, current } = vi.hoisted(() => ({
	isoFromToday: (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	},
	current: { failed: false }
}));

// The profile is unlocked with a separation date and the calendar store has loaded; the timeline store holds statuses
// from an earlier read, and each test sets whether its last read failed.
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		store: {
			locked: false,
			clockBackward: false,
			persona: { completeness: 'eaos-only', eaos: isoFromToday(200), daysUntilSeparation: 200 }
		},
		timeline: { ready: true, failed: current.failed, state: { schemaVersion: 1, tasks: {} } },
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

describe('Settings, the calendar add after the timeline fails to re-read', () => {
	// The statuses in memory may be out of date, so a file built from them could carry a task another tab marked done.
	it('turns Add off while the timeline says its last read failed', async () => {
		current.failed = true;
		await render(SettingsPage);
		await expect
			.element(page.getByRole('button', { name: /^add to my calendar$/i }))
			.toBeDisabled();
	});

	it('offers Add once the timeline has read', async () => {
		current.failed = false;
		await render(SettingsPage);
		await expect.element(page.getByRole('button', { name: /^add to my calendar$/i })).toBeEnabled();
	});
});
