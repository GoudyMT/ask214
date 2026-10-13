import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
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
		// Whether the erase's first step locks the page, as it does once the profile has loaded.
		relocks: true,
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
			if (ctl.relocks) profile.locked = true;
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
	ctl.relocks = true;
	ctl.wipeAll = async () => {
		throw new Error('E_TEST_WIPE');
	};
});

const after = <T>(ms: number, value: () => T) =>
	new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// A control outside the page, which the person moves focus to while the page works.
async function withFocusElsewhere(run: (elsewhere: HTMLElement) => Promise<void>): Promise<void> {
	const elsewhere = document.body.appendChild(document.createElement('button'));
	try {
		await run(elsewhere);
	} finally {
		elsewhere.remove();
	}
}
// By keyboard a focus target shows the app's focus ring - a 2 px solid outline with a 2 px gap, as on every button.
// Component tests run without app.css; the ring's colour token is set here as the app defines it, and removed.
async function expectAppRing(target: () => Element | null): Promise<void> {
	document.documentElement.style.setProperty('--color-accent', '#1a66c2');
	try {
		await expect.poll(() => document.activeElement).toBe(target());
		const ring = getComputedStyle(target()!);
		expect([ring.outlineStyle, ring.outlineWidth, ring.outlineOffset, ring.outlineColor]).toEqual([
			'solid',
			'2px',
			'2px',
			'rgb(26, 102, 194)'
		]);
	} finally {
		document.documentElement.style.removeProperty('--color-accent');
	}
}
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

	it('rings the timeline heading the way the app rings a button, after a keyboard press', async () => {
		ctl.clearClock = async () => {
			profile.clockBackward = false;
		};
		await render(SettingsPage);
		(clockFix().element() as HTMLElement).focus();
		await userEvent.keyboard('{Enter}');
		await expectAppRing(() => document.getElementById('timeline-heading'));
	});

	it('leaves focus alone when the person moved it while the fix ran', async () => {
		ctl.clearClock = () =>
			after(100, () => {
				profile.clockBackward = false;
			});
		await render(SettingsPage);
		await withFocusElsewhere(async (elsewhere) => {
			await clockFix().click();
			elsewhere.focus();
			await expect.poll(() => clockFix().query()).toBeNull();
			await pause(50);
			expect(document.activeElement).toBe(elsewhere);
		});
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

			// Read inside the poll: focus arrives only after the prompt's answer.
			await expect
				.poll(() => document.activeElement === document.getElementById('install-heading'))
				.toBe(true);
			expect(page.getByRole('button', { name: 'Install', exact: true }).query()).toBeNull();
		}
	);

	// In a real browser the prompt's answer comes first and the installed signal (`appinstalled`) later, so the section
	// changes after focus has reached its heading.
	it('keeps focus on the Install heading when the installed signal comes after the answer', async () => {
		ctl.prompt = async () => 'dismissed';
		await render(SettingsPage);
		await page.getByRole('button', { name: 'Install', exact: true }).click();
		await expect
			.poll(() => document.activeElement === document.getElementById('install-heading'))
			.toBe(true);

		install.installed = true;
		await expect.element(page.getByText('Ask 214 is installed on this device.')).toBeVisible();
		expect(document.activeElement).toBe(document.getElementById('install-heading'));
	});
});

describe('Settings, an erase that fails', () => {
	it('hands focus to the failure line when the page has locked under the erase', async () => {
		const { container } = await render(SettingsPage);
		await page.getByRole('button', { name: 'Erase all data on this device' }).click();
		await page.getByRole('button', { name: 'Erase everything' }).click();

		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.poll(() => document.activeElement).toBe(container.querySelector('.erase-error'));
	});

	// The erase can fail before it locks the page: focus is then still on the button that opened the dialog.
	it('hands focus to the failure line from the button that opened the dialog', async () => {
		ctl.relocks = false;
		const { container } = await render(SettingsPage);
		const opener = page.getByRole('button', { name: 'Erase all data on this device' });
		await opener.click();
		await page.getByRole('button', { name: 'Erase everything' }).click();

		await expect.element(page.getByRole('alert')).toBeVisible();
		expect(opener.query()).not.toBeNull();
		await expect.poll(() => document.activeElement).toBe(container.querySelector('.erase-error'));
	});

	it('rings the failure line the way the app rings a button, after a keyboard press', async () => {
		const { container } = await render(SettingsPage);
		await page.getByRole('button', { name: 'Erase all data on this device' }).click();
		(page.getByRole('button', { name: 'Erase everything' }).element() as HTMLElement).focus();
		await userEvent.keyboard('{Enter}');
		await expectAppRing(() => container.querySelector('.erase-error'));
	});

	it('leaves focus alone when the person moved it while the erase ran', async () => {
		ctl.wipeAll = () =>
			new Promise((_, reject) => setTimeout(() => reject(new Error('E_TEST_WIPE')), 100));
		await render(SettingsPage);
		await page.getByRole('button', { name: 'Erase all data on this device' }).click();
		await withFocusElsewhere(async (elsewhere) => {
			await page.getByRole('button', { name: 'Erase everything' }).click();
			elsewhere.focus();
			await expect.element(page.getByRole('alert')).toBeVisible();
			await pause(50);
			expect(document.activeElement).toBe(elsewhere);
		});
	});
});
