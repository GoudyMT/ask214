import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';
import { OccConflictError } from '$lib/profile/store.svelte';

// Days from the real clock: the page reads its separation date against today.
const { isoFromToday, timeline } = vi.hoisted(() => ({
	isoFromToday: (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	},
	timeline: {
		ready: true,
		failed: false,
		locked: false,
		state: { schemaVersion: 1, tasks: {} },
		setStatus: vi.fn(),
		setSnooze: vi.fn(),
		refresh: vi.fn()
	}
}));

// The profile is unlocked with a separation date: without one the page does not render the Transition timeline section,
// and the row is inside it.
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		store: {
			locked: false,
			clockBackward: false,
			persona: { completeness: 'eaos-only', eaos: isoFromToday(200), daysUntilSeparation: 200 }
		},
		timeline,
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

const OCC_MESSAGE =
	'This was changed in another tab. We reloaded it - please review and save again.';
const FAILED = 'Could not update right now - please try again.';

beforeEach(() => {
	timeline.ready = true;
	timeline.failed = false;
	timeline.locked = false;
	timeline.setStatus.mockReset().mockResolvedValue(undefined);
	timeline.setSnooze.mockReset().mockResolvedValue(undefined);
	timeline.refresh.mockReset().mockResolvedValue(undefined);
});

const toggle = () => page.getByRole('button', { name: /^planning skillbridge/i });
// The page has other Save buttons (the online key's), so the row's own section is the scope.
const timelineSection = () => page.getByRole('region', { name: 'Transition timeline' });
// The radios exist only while the row is open.
const choice = (answer: 'Yes' | 'No') =>
	timelineSection().getByRole('radio', { name: answer, exact: true });

async function pickAndSave(answer: 'Yes' | 'No'): Promise<void> {
	await toggle().click();
	await choice(answer).click();
	await timelineSection()
		.getByRole('button', { name: /^save$/i })
		.click();
}

describe('Settings, the Planning SkillBridge row', () => {
	it('shows the other-tab message and re-reads the store when the save lost a race', async () => {
		timeline.setStatus.mockRejectedValue(new OccConflictError());
		await render(SettingsPage);
		await pickAndSave('Yes');
		await expect.element(page.getByText(OCC_MESSAGE)).toBeVisible();
		expect(timeline.refresh).toHaveBeenCalledTimes(1);
	});

	it('shows the try-again message and re-reads the store when the save failed otherwise', async () => {
		timeline.setStatus.mockRejectedValue(new Error('E_TEST'));
		await render(SettingsPage);
		await pickAndSave('Yes');
		await expect.element(page.getByText(FAILED)).toBeVisible();
		expect(page.getByText(OCC_MESSAGE).query()).toBeNull();
		expect(timeline.refresh).toHaveBeenCalledTimes(1);
	});

	it('writes Yes as done and closes the row', async () => {
		await render(SettingsPage);
		await pickAndSave('Yes');
		await expect.element(choice('Yes')).not.toBeInTheDocument();
		expect(timeline.setStatus).toHaveBeenCalledTimes(1);
		expect(timeline.setStatus).toHaveBeenCalledWith('skillbridge-plan', 'done');
		expect(timeline.refresh).not.toHaveBeenCalled();
	});

	it('writes No as skipped, not as the Yes it would be if the answer were fixed', async () => {
		await render(SettingsPage);
		await pickAndSave('No');
		await expect.element(choice('No')).not.toBeInTheDocument();
		expect(timeline.setStatus).toHaveBeenCalledTimes(1);
		expect(timeline.setStatus).toHaveBeenCalledWith('skillbridge-plan', 'skipped');
	});

	it('reads Not answered and is enabled when the timeline has read', async () => {
		await render(SettingsPage);
		await expect.element(toggle()).toBeEnabled();
		await expect.element(toggle()).toMatchTextContent('Not answered');
	});

	it('reads Unavailable and is disabled when the timeline failed to read', async () => {
		timeline.failed = true;
		await render(SettingsPage);
		await expect.element(toggle()).toBeDisabled();
		await expect.element(toggle()).toMatchTextContent('Unavailable');
	});

	it('reads Unavailable and is disabled when the timeline is locked', async () => {
		timeline.locked = true;
		await render(SettingsPage);
		await expect.element(toggle()).toBeDisabled();
		await expect.element(toggle()).toMatchTextContent('Unavailable');
	});
});
