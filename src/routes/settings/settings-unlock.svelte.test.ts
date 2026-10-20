import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import SettingsPage from './+page.svelte';

const { isoFromToday, ctl } = vi.hoisted(() => ({
	isoFromToday: (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	},
	// What the profile store's load and relock do this test: the cases set them, beforeEach resets them.
	ctl: { load: async (): Promise<void> => {}, relock: (): void => {} }
}));

// Reactive, unlike a plain flag: Unlock opens the profile and Lock closes it, and the page swaps its sections at that moment.
const profile = $state({ locked: true });
const loads = vi.fn();
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		store: {
			get locked() {
				return profile.locked;
			},
			load: () => {
				loads();
				return ctl.load();
			},
			clockBackward: false,
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
		wipeAll: null,
		relockAll: () => ctl.relock(),
		joinRelock: null,
		publish: null,
		reloadOnUnlock: false,
		replacedNotice: false
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

const FAILED = 'Could not unlock right now - please try again.';
// Enter as a keyboard sends it: the key, its code and the carriage return it types.
const ENTER = {
	key: 'Enter',
	code: 'Enter',
	windowsVirtualKeyCode: 13,
	text: String.fromCharCode(13)
};

const unhandled: unknown[] = [];
const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e.reason);

beforeEach(() => {
	unhandled.length = 0;
	window.addEventListener('unhandledrejection', onUnhandled);
	profile.locked = true;
	loads.mockClear();
	ctl.load = async () => {
		profile.locked = false;
	};
	// As the layout's is: the profile reads as locked at once.
	ctl.relock = () => {
		profile.locked = true;
	};
});
afterEach(() => {
	window.removeEventListener('unhandledrejection', onUnhandled);
});

// A load that ends after `ms`: it opens the profile, or it rejects.
const endsAfter = (ms: number, fails: boolean) => () =>
	new Promise<void>((resolve, reject) =>
		setTimeout(() => {
			if (fails) return reject(new Error('E_TEST_LOAD'));
			profile.locked = false;
			resolve();
		}, ms)
	);

const TIMINGS = [
	['ends at once', 0],
	['takes a while', 100]
] as const;

const unlockButton = (root: Element) =>
	root.querySelector<HTMLButtonElement>('.locked-panel__unlock');
const heading = () => page.getByRole('heading', { level: 1, name: 'Settings' });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Settings, Unlock', () => {
	it.each(TIMINGS)(
		'says so and keeps focus on Unlock when the load %s and fails',
		async (_, ms) => {
			ctl.load = endsAfter(ms, true);
			const { container } = await render(SettingsPage);
			await page.getByRole('button', { name: 'Unlock' }).click();

			await expect.element(page.getByRole('alert')).toHaveTextContent(FAILED);
			const unlock = unlockButton(container);
			await expect.poll(() => document.activeElement).toBe(unlock);
			await pause(50);
			expect(unhandled).toEqual([]);
		}
	);

	it.each(TIMINGS)('puts focus on the heading when the load %s and succeeds', async (_, ms) => {
		ctl.load = endsAfter(ms, false);
		await render(SettingsPage);
		await page.getByRole('button', { name: 'Unlock' }).click();

		await expect.element(heading()).toBeVisible();
		await expect.poll(() => document.activeElement).toBe(heading().element());
		expect(page.getByRole('alert').query()).toBeNull();
	});

	// By keyboard the heading shows the app's focus ring - a 2 px solid outline with a 2 px gap, as on every button.
	it('rings the heading the way the app rings a button, when Unlock was pressed by keyboard', async () => {
		// Component tests run without app.css; the ring's colour token is set here as the app defines it, and removed.
		document.documentElement.style.setProperty('--color-accent', '#1a66c2');
		try {
			const { container } = await render(SettingsPage);
			unlockButton(container)?.focus();
			await userEvent.keyboard('{Enter}');
			await expect.poll(() => document.activeElement).toBe(heading().element());
			const ring = getComputedStyle(heading().element());
			expect([ring.outlineStyle, ring.outlineWidth, ring.outlineOffset, ring.outlineColor]).toEqual(
				['solid', '2px', '2px', 'rgb(26, 102, 194)']
			);
		} finally {
			document.documentElement.style.removeProperty('--color-accent');
		}
	});

	// Focus that follows a pointer press shows no ring: the rule is :focus-visible, which a pointer does not raise.
	it('shows no ring on the heading when Unlock was pressed by pointer', async () => {
		document.documentElement.style.setProperty('--color-accent', '#1a66c2');
		try {
			await render(SettingsPage);
			await page.getByRole('button', { name: 'Unlock' }).click();
			await expect.poll(() => document.activeElement).toBe(heading().element());
			expect(getComputedStyle(heading().element()).outlineStyle).not.toBe('solid');
		} finally {
			document.documentElement.style.removeProperty('--color-accent');
		}
	});

	it('leaves focus alone when the person moved it while the load ran', async () => {
		ctl.load = endsAfter(100, false);
		await render(SettingsPage);
		const elsewhere = document.body.appendChild(document.createElement('button'));
		try {
			await page.getByRole('button', { name: 'Unlock' }).click();
			elsewhere.focus();
			// The load has ended once the panel is gone; give the page's own focus step its turn.
			await expect.poll(() => profile.locked).toBe(false);
			await expect.element(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
			await pause(50);
			expect(document.activeElement).toBe(elsewhere);
		} finally {
			elsewhere.remove();
		}
	});

	it('hands focus to Unlock when Lock replaces itself with it', async () => {
		profile.locked = false;
		const { container } = await render(SettingsPage);
		await page.getByRole('button', { name: 'Lock', exact: true }).click();

		await expect.element(page.getByRole('button', { name: 'Unlock' })).toBeVisible();
		await expect.poll(() => document.activeElement).toBe(unlockButton(container));
	});

	// A held key repeats about every 40 ms; a repeat that reached Unlock while it works would read the profile again,
	// and a button turned off for the work would drop the focus the repeats rely on.
	it.each(TIMINGS)('reads once for a held Enter on Unlock when the load %s', async (_, ms) => {
		ctl.load = endsAfter(ms, false);
		const { container } = await render(SettingsPage);
		const unlock = unlockButton(container);
		unlock?.focus();
		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		for (let i = 0; i < 6; i++) {
			await pause(40);
			if (container.contains(unlock)) expect(document.activeElement).toBe(unlock);
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
		}
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });

		await expect.poll(() => profile.locked).toBe(false);
		await expect.poll(() => document.activeElement).toBe(heading().element());
		expect(loads).toHaveBeenCalledOnce();
	});

	// Lock hands focus to Unlock during the key press, so the same held key's repeats land on Unlock.
	it.each(TIMINGS)('stays locked for a held Enter on Lock (a load that %s)', async (_, ms) => {
		ctl.load = endsAfter(ms, false);
		profile.locked = false;
		const { container } = await render(SettingsPage);
		(page.getByRole('button', { name: 'Lock', exact: true }).element() as HTMLElement).focus();
		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		for (let i = 0; i < 6; i++) {
			await pause(40);
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
		}
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await pause(ms + 50);

		expect(loads).not.toHaveBeenCalled();
		expect(profile.locked).toBe(true);
		expect(document.activeElement).toBe(unlockButton(container));
	});

	// A Lock pressed while a profile save runs is held until the save ends (the store defers the relock), so the page
	// swaps to the locked panel later than the press.
	it('hands focus to Unlock when a Lock pressed during a save lands later', async () => {
		ctl.relock = () => void setTimeout(() => (profile.locked = true), 100);
		profile.locked = false;
		const { container } = await render(SettingsPage);
		(page.getByRole('button', { name: 'Lock', exact: true }).element() as HTMLElement).focus();
		await userEvent.keyboard('{Enter}');

		await expect.element(page.getByRole('button', { name: 'Unlock' })).toBeVisible();
		await expect.poll(() => document.activeElement).toBe(unlockButton(container));
	});

	it('stays locked for a held Enter on a Lock pressed during a save', async () => {
		ctl.relock = () => void setTimeout(() => (profile.locked = true), 100);
		profile.locked = false;
		const { container } = await render(SettingsPage);
		(page.getByRole('button', { name: 'Lock', exact: true }).element() as HTMLElement).focus();
		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		for (let i = 0; i < 6; i++) {
			await pause(40);
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
		}
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await pause(150);

		expect(loads).not.toHaveBeenCalled();
		expect(profile.locked).toBe(true);
		expect(document.activeElement).toBe(unlockButton(container));
	});

	it.each(TIMINGS)(
		'reads once for a held Enter on an Unlock whose load %s and fails',
		async (_, ms) => {
			ctl.load = endsAfter(ms, true);
			const { container } = await render(SettingsPage);
			unlockButton(container)?.focus();
			const session = cdp();
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
			for (let i = 0; i < 6; i++) {
				await pause(40);
				await session.send('Input.dispatchKeyEvent', {
					type: 'keyDown',
					autoRepeat: true,
					...ENTER
				});
			}
			await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });

			await expect.element(page.getByRole('alert')).toHaveTextContent(FAILED);
			await pause(150);
			expect(loads).toHaveBeenCalledOnce();
		}
	);

	// The profile can open without Unlock (the app re-reads it on its own), so a failure line must not outlive the lock.
	it('drops the failure line when the profile opens some other way', async () => {
		ctl.load = endsAfter(0, true);
		await render(SettingsPage);
		await page.getByRole('button', { name: 'Unlock' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(FAILED);

		profile.locked = false;
		await page.getByRole('button', { name: 'Lock', exact: true }).click();
		await expect.element(page.getByRole('button', { name: 'Unlock' })).toBeVisible();
		expect(page.getByRole('alert').query()).toBeNull();
	});

	// A read that fails after the profile has opened another way belongs to no lock: the next lock starts without it.
	it('shows no line at the next lock when the read failed after the profile had opened', async () => {
		ctl.load = () =>
			new Promise<void>((_, reject) => {
				setTimeout(() => (profile.locked = false), 30);
				setTimeout(() => reject(new Error('E_TEST_LOAD')), 80);
			});
		await render(SettingsPage);
		await page.getByRole('button', { name: 'Unlock' }).click();
		await expect.element(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
		await pause(100);

		await page.getByRole('button', { name: 'Lock', exact: true }).click();
		await expect.element(page.getByRole('button', { name: 'Unlock' })).toBeVisible();
		expect(page.getByRole('alert').query()).toBeNull();
	});

	// A second failure that reads the same as the first is announced again only if the line was taken away at the press.
	it('takes the line away at the next press and shows it again', async () => {
		// The second read stays pending, so the line can only be gone because the press started it, not because it failed.
		let fail: (reason: Error) => void = () => {};
		let attempt = 0;
		ctl.load = () =>
			++attempt === 1
				? Promise.reject(new Error('E_TEST_LOAD'))
				: new Promise<void>((_, reject) => (fail = reject));
		await render(SettingsPage);
		await page.getByRole('button', { name: 'Unlock' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(FAILED);

		await page.getByRole('button', { name: 'Unlock' }).click();
		await expect.poll(() => attempt).toBe(2);
		await expect.poll(() => page.getByRole('alert').query()).toBeNull();

		fail(new Error('E_TEST_LOAD'));
		await expect.element(page.getByRole('alert')).toHaveTextContent(FAILED);
	});
});
