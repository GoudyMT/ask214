import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';
// The spacing tokens the page's gaps are drawn from.
import '../../app.css';

const { isoFromToday } = vi.hoisted(() => ({
	isoFromToday: (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
}));

// Reactive, as the layout's app object is: the page swaps its sections the moment a lock or an unlock lands.
const lock = $state({ mode: 'pin' as 'pin' | 'local', pinLocked: true, storeLocked: true });
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		get keyMode() {
			return lock.mode;
		},
		get pinLocked() {
			return lock.pinLocked;
		},
		store: {
			get locked() {
				return lock.storeLocked;
			},
			load: async () => {},
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
		db: {},
		wipeAll: null,
		// A Lock in PIN mode drops the keys too, so the card comes back; in local mode only the profile locks.
		relockAll: () => {
			lock.storeLocked = true;
			lock.pinLocked = lock.mode === 'pin';
		},
		unlockStores: async () => {
			lock.pinLocked = false;
			lock.storeLocked = false;
		},
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
// The check itself is the card's own test; here it only has to end well.
vi.mock('$lib/keystore/app-lock-store', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/keystore/app-lock-store')>()),
	readTries: async () => ({ count: 0, waitMs: 0, pending: false }),
	runPinCheck: async () => ({ kind: 'good', value: true, wrongTries: 0, unfinished: false })
}));

beforeEach(() => {
	lock.mode = 'pin';
	lock.pinLocked = true;
	lock.storeLocked = true;
});

const cardHeading = () => page.getByRole('heading', { name: 'Your data is locked' });
const pinField = () => page.getByLabelText('PIN', { exact: true });
const lockButton = () => page.getByRole('button', { name: 'Lock', exact: true });
const pageHeading = () => page.getByRole('heading', { level: 1, name: 'Settings' });

describe('Settings, locked with a PIN', () => {
	// With no saved profile the store reads unlocked after a Lock, but the keys are still gone: the card, not the page.
	it.each([
		['the profile reads locked', true],
		['the profile reads unlocked (nothing saved)', false]
	])('shows the PIN card, and nothing behind it, when %s', async (_name, storeLocked) => {
		lock.storeLocked = storeLocked;
		const { container } = await render(SettingsPage);

		await expect.element(cardHeading()).toBeVisible();
		await expect.element(pinField()).toBeVisible();
		expect(container.querySelector('.locked-panel')).toBeNull();
		// The Lock button and the online-answers settings (the API key) are behind the keys.
		expect(lockButton().query()).toBeNull();
		expect(page.getByRole('heading', { name: 'Online answers' }).query()).toBeNull();
	});

	// Local mode is as it was: the one-button panel, no field.
	it('keeps the one-button panel for a lock without a PIN', async () => {
		lock.mode = 'local';
		lock.pinLocked = false;
		const { container } = await render(SettingsPage);

		await expect.element(cardHeading()).toBeVisible();
		expect(container.querySelector('.locked-panel__unlock')).not.toBeNull();
		expect(pinField().query()).toBeNull();
	});

	it('puts the cursor in the PIN field when Lock brings the card up', async () => {
		lock.pinLocked = false;
		lock.storeLocked = false;
		await render(SettingsPage);
		await lockButton().click();

		await expect.element(pinField()).toBeVisible();
		await expect.poll(() => document.activeElement).toBe(pinField().element());
	});

	it('takes the card away and puts focus on the page heading when the unlock lands', async () => {
		await render(SettingsPage);
		await pinField().fill('1234');
		await page.getByRole('button', { name: 'Unlock', exact: true }).click();

		await expect.element(lockButton()).toBeVisible();
		expect(cardHeading().query()).toBeNull();
		await expect.poll(() => document.activeElement).toBe(pageHeading().element());
	});

	// The card stands between two sections, so it keeps the gap the sections keep between each other.
	it.each([320, 1280])('keeps the section gap above and below the card at %i px', async (width) => {
		const size = { width: window.innerWidth, height: window.innerHeight };
		await page.viewport(width, 800);
		try {
			const { container } = await render(SettingsPage);
			await expect.element(cardHeading()).toBeVisible();
			const box = (selector: string) => {
				const el = container.querySelector(selector);
				if (!el) throw new Error('E_TEST_MISSING_ELEMENT');
				return el.getBoundingClientRect();
			};
			const appearance = box('[aria-labelledby="appearance-heading"]');
			const install = box('[aria-labelledby="install-heading"]');
			const sectionGap = install.top - appearance.bottom;
			expect(sectionGap).toBeGreaterThan(0);
			const card = box('.pin-unlock');
			expect(card.top - box('[aria-labelledby="documents-heading"]').bottom).toBe(sectionGap);
			expect(box('[aria-labelledby="privacy-heading"]').top - card.bottom).toBe(sectionGap);
		} finally {
			await page.viewport(size.width, size.height);
		}
	});
});
