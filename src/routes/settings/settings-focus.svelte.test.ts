import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';

const { isoFromToday, ctl } = vi.hoisted(() => ({
	isoFromToday: (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	},
	// What the stores and the install controller do this test: the cases set them, beforeEach resets them.
	ctl: {
		clearClock: async (): Promise<void> => {},
		prompt: async (): Promise<'accepted' | 'dismissed'> => 'dismissed',
		wipeAll: async (): Promise<void> => {
			throw new Error('E_TEST_WIPE');
		}
	}
}));

// Reactive, unlike a plain flag: each control below goes away when the state it acts on changes, as it does in the app.
const profile = $state({ locked: false, clockBackward: true });
const install = $state({ installed: false, canPrompt: true, ios: false, persisted: false });
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		store: {
			get locked() {
				return profile.locked;
			},
			get clockBackward() {
				return profile.clockBackward;
			},
			clearClockBackward: () => ctl.clearClock(),
			persona: { completeness: 'eaos-only', eaos: isoFromToday(200), daysUntilSeparation: 200 }
		},
		timeline: {
			ready: true,
			failed: false,
			locked: false,
			state: { schemaVersion: 1, tasks: {} },
			refresh: () => Promise.resolve(),
			load: () => Promise.resolve()
		},
		calendar: {
			ready: true,
			failed: false,
			locked: false,
			load: () => Promise.resolve(),
			exclusions: { taskIds: [], categories: [] },
			lastAdd: []
		},
		byok: null,
		cause: null,
		wipeAll: () => ctl.wipeAll(),
		// As the layout's is: the profile reads as locked at once.
		relockAll: () => {
			profile.locked = true;
		}
	}),
	setProfileApp: () => {}
}));
vi.mock('$lib/install/context', () => ({
	getInstallApp: () => ({
		get installed() {
			return install.installed;
		},
		get canPrompt() {
			return install.canPrompt;
		},
		ios: false,
		get persisted() {
			return install.persisted;
		},
		// The controller clears canPrompt whatever the answer; an accepted install is then installed.
		promptInstall: async () => {
			const outcome = await ctl.prompt();
			if (outcome === 'accepted') install.installed = true;
			install.canPrompt = false;
			return outcome;
		}
	}),
	setInstallApp: () => {}
}));

const CLOCK_FAILED = 'Could not update right now - please try again.';

beforeEach(() => {
	profile.locked = false;
	profile.clockBackward = true;
	install.installed = false;
	install.canPrompt = true;
	install.persisted = false;
	ctl.clearClock = async () => {};
	ctl.prompt = async () => 'dismissed';
	ctl.wipeAll = async () => {
		throw new Error('E_TEST_WIPE');
	};
});

const after = <T>(ms: number, value: () => T) =>
	new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));
const clockFix = () => page.getByRole('button', { name: 'I fixed my clock' });

describe('Settings, the clock fix', () => {
	it('hands focus to the timeline heading when the fix removes its button', async () => {
		ctl.clearClock = () =>
			after(50, () => {
				profile.clockBackward = false;
			});
		await render(SettingsPage);
		await clockFix().click();

		const heading = page.getByRole('heading', { level: 2, name: 'Transition timeline' });
		await expect.poll(() => document.activeElement).toBe(heading.element());
		expect(clockFix().query()).toBeNull();
	});

	// Guard: a fix that fails leaves the button where it is, with the line that says so.
	it('keeps focus on the button, with the line, when the fix fails', async () => {
		ctl.clearClock = () => Promise.reject(new Error('E_TEST_CLEAR'));
		await render(SettingsPage);
		await clockFix().click();

		await expect.element(page.getByRole('alert')).toHaveTextContent(CLOCK_FAILED);
		await expect.poll(() => document.activeElement).toBe(clockFix().element());
	});
});

describe('Settings, Install', () => {
	it.each([['accepted'], ['dismissed']] as const)(
		'hands focus to the Install heading when the prompt is %s and removes the button',
		async (outcome) => {
			ctl.prompt = () => after(50, () => outcome);
			await render(SettingsPage);
			await page.getByRole('button', { name: 'Install', exact: true }).click();

			// Read inside the poll: an accepted install swaps the section's heading for a new element.
			await expect
				.poll(() => document.activeElement === document.getElementById('install-heading'))
				.toBe(true);
			expect(page.getByRole('button', { name: 'Install', exact: true }).query()).toBeNull();
		}
	);
});

describe('Settings, an erase that fails', () => {
	it('hands focus to the failure line when the page has locked under the erase', async () => {
		const { container } = await render(SettingsPage);
		await page.getByRole('button', { name: 'Erase all data on this device' }).click();
		await page.getByRole('button', { name: 'Erase everything' }).click();

		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.poll(() => document.activeElement).toBe(container.querySelector('.erase-error'));
	});
});
