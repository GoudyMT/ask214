import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { backupSession } from '$lib/backup/session.svelte';
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
const lock = $state({
	mode: 'pin' as 'pin' | 'local',
	pinLocked: true,
	storeLocked: true,
	// The start-up seams the backup card needs (the relock list and the tab signal), off unless a case turns them on, and
	// the store's lock state as an in-tab Lock leaves it.
	backupSeams: false,
	lockState: 'locked' as 'locked' | 'unlocked'
});
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
			get lockState() {
				return lock.lockState;
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
		get joinRelock() {
			return lock.backupSeams ? () => () => {} : null;
		},
		get publish() {
			return lock.backupSeams ? () => {} : null;
		},
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
	lock.backupSeams = false;
	lock.lockState = 'locked';
});

afterEach(() => {
	// A restore started from the Forgot screen leaves the tab's one backup session running.
	backupSession.relockSync('user');
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

	// A PIN device with nothing saved, locked in this tab: the store reads unlocked, and the page's keep-alive for a card
	// whose session is running (the app-switch case of a local lock) would draw the ordinary Backup card beside the Forgot
	// screen's own, sharing its session. Locked Settings shows App lock, the backup off, and the Erase.
	it('draws no ordinary Backup card while the PIN lock is on, even with a restore running from the Forgot screen', async () => {
		lock.backupSeams = true;
		lock.storeLocked = false;
		await render(SettingsPage);
		await page.getByRole('button', { name: 'Forgot PIN?', exact: true }).click();
		await page.getByRole('button', { name: 'Restore from a backup', exact: true }).click();
		await expect.poll(() => backupSession.active).toBe(true);
		await expect.poll(() => document.querySelectorAll('#backup-toggle-restore').length).toBe(1);

		expect(page.getByRole('heading', { name: 'Backup', exact: true }).query()).toBeNull();
		expect(document.querySelectorAll('#backup-toggle-export, #backup-toggle-check')).toHaveLength(
			0
		);
		expect(document.querySelectorAll('.backup-card')).toHaveLength(1);
	});

	// The page has the Erase dialog itself, so the card's Erase and start over opens that one: no trip to another page.
	it('Forgot PIN, then Erase and start over, opens the page Erase dialog', async () => {
		await render(SettingsPage);
		const dialog = () => document.querySelector<HTMLDialogElement>('dialog.wipe-dialog');
		expect(dialog()?.open).toBe(false);

		await page.getByRole('button', { name: 'Forgot PIN?', exact: true }).click();
		await page.getByRole('button', { name: 'Erase and start over', exact: true }).click();

		await expect.poll(() => dialog()?.open).toBe(true);
	});

	// The Erase dialog opens with focus on Cancel. A key still held from the button that opened it must not reach Cancel:
	// its repeats would close the dialog the moment it came up.
	it('an Enter held on Erase and start over opens the Erase dialog once the key is let go, and it stays open', async () => {
		await render(SettingsPage);
		const dialog = () => document.querySelector<HTMLDialogElement>('dialog.wipe-dialog');
		await page.getByRole('button', { name: 'Forgot PIN?', exact: true }).click();
		const erase = page.getByRole('button', { name: 'Erase and start over', exact: true });
		await expect.element(erase).toBeVisible();
		(erase.element() as HTMLButtonElement).focus();
		const keys = cdp();
		const enter = {
			key: 'Enter',
			code: 'Enter',
			windowsVirtualKeyCode: 13,
			text: String.fromCharCode(13)
		};

		await keys.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter });
		for (let i = 0; i < 4; i += 1) {
			await new Promise((done) => setTimeout(done, 40));
			await keys.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...enter });
		}
		expect(dialog()?.open).toBe(false);
		await keys.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });

		await expect.poll(() => dialog()?.open).toBe(true);
		await new Promise((done) => setTimeout(done, 100));
		expect(dialog()?.open).toBe(true);
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
