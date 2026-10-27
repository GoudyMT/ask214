import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { LOCKED_AFTER_RESTORE_LINE, RESTORED_UNLOCK_LINE } from '$lib/backup/copy';
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
// The check itself is the card's own test; here it only has to end well, with the tries a case says came before it.
const before = vi.hoisted(() => ({ wrongTries: 0, unfinished: false }));
vi.mock('$lib/keystore/app-lock-store', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/keystore/app-lock-store')>()),
	readTries: async () => ({ count: 0, waitMs: 0, pending: false }),
	runPinCheck: async () => ({ kind: 'good', value: true, ...before })
}));

beforeEach(() => {
	before.wrongTries = 0;
	before.unfinished = false;
	lock.mode = 'pin';
	lock.pinLocked = true;
	lock.storeLocked = true;
	lock.backupSeams = false;
	lock.lockState = 'locked';
});

afterEach(() => {
	// A restore started from the Forgot screen leaves the tab's one backup session running; a finished one ends through `done`.
	if (backupSession.active) {
		backupSession.enterPhase('done');
		backupSession.end();
	}
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

	async function unlockOnce(): Promise<void> {
		await pinField().fill('1234');
		await page.getByRole('button', { name: 'Unlock', exact: true }).click();
		await expect.poll(() => cardHeading().query()).toBeNull();
	}
	const noticeLines = (region: Element | null) =>
		[...(region?.querySelectorAll('p') ?? [])].map((p) => p.textContent?.trim());

	// The person is told what the tries before this good PIN were, where the card stood. The region is on the page before
	// its lines arrive, so a screen reader is already listening, and the next unlock replaces what it said.
	it('tells the person the wrong tries before a good PIN in a status region that was already there, and the next unlock replaces it', async () => {
		before.wrongTries = 4;
		before.unfinished = true;
		const { container } = await render(SettingsPage);
		const region = container.querySelector('.settings-notice');
		expect(region?.getAttribute('role')).toBe('status');
		expect(noticeLines(region)).toEqual([]);

		await unlockOnce();
		expect(container.querySelector('.settings-notice')).toBe(region);
		expect(noticeLines(region)).toEqual([
			'3 wrong PIN tries since your last unlock.',
			'One PIN try did not finish.'
		]);

		before.wrongTries = 0;
		before.unfinished = false;
		lock.pinLocked = true;
		lock.storeLocked = true;
		await expect.element(cardHeading()).toBeVisible();
		await unlockOnce();
		expect(container.querySelector('.settings-notice')).toBe(region);
		expect(noticeLines(region)).toEqual([]);
	});

	// A Lock ends the visit the notice was about: it must not sit above "Your data is locked", and the same tries after the
	// next unlock are news again, so the line has to arrive as a new node for a screen reader to speak it.
	it('empties the notice when the page locks, and brings the same notice back as a new line after the next unlock', async () => {
		before.wrongTries = 3;
		const { container } = await render(SettingsPage);
		const region = container.querySelector('.settings-notice');
		await unlockOnce();
		expect(noticeLines(region)).toEqual(['3 wrong PIN tries since your last unlock.']);

		lock.pinLocked = true;
		lock.storeLocked = true;
		await expect.element(cardHeading()).toBeVisible();
		expect(container.querySelector('.settings-notice')).toBe(region);
		expect(noticeLines(region)).toEqual([]);

		const arrived: (string | undefined)[] = [];
		const watch = new MutationObserver((records) => {
			for (const record of records)
				for (const node of record.addedNodes) arrived.push(node.textContent?.trim());
		});
		watch.observe(region as Element, { childList: true });
		await unlockOnce();
		await expect
			.poll(() => noticeLines(region))
			.toEqual(['3 wrong PIN tries since your last unlock.']);
		watch.disconnect();
		expect(arrived).toEqual(['3 wrong PIN tries since your last unlock.']);
	});

	// A restore that has just committed: the write is done, and the page is about to move on or to be locked.
	function commitRestore(lockedAfter: boolean): void {
		backupSession.start(
			{ status: 'ready', joinRelock: () => () => {}, publish: () => {} },
			'restore'
		);
		backupSession.enterPhase('committed');
		backupSession.lockedAfterRestore = lockedAfter;
	}
	const restoredLines = () =>
		[RESTORED_UNLOCK_LINE, LOCKED_AFTER_RESTORE_LINE].filter(
			(line) => page.getByText(line).query() !== null
		);
	const twoFrames = () =>
		new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));

	// A restore from the Forgot screen on a device that had its lock turned off by the backup: the flow moves on after a
	// moment, and until it does the sentence would tell the person to unlock a device that needs no PIN.
	it('says nothing about a restore above the Forgot screen while the restore has just committed', async () => {
		await render(SettingsPage);
		await page.getByRole('button', { name: 'Forgot PIN?', exact: true }).click();
		await expect
			.element(page.getByRole('heading', { name: 'Forgot your PIN?', exact: true }))
			.toBeVisible();

		commitRestore(false);
		await twoFrames();

		expect(restoredLines()).toEqual([]);
	});

	// A restore on an unlocked PIN-mode Settings that commits as Lock lands: the Unlock card is up with no Forgot screen, and
	// the sentence is true.
	it('says the device was locked after the restore above the Unlock card, when the Forgot screen is not up', async () => {
		await render(SettingsPage);
		await expect.element(cardHeading()).toBeVisible();

		commitRestore(true);

		await expect.element(page.getByText(LOCKED_AFTER_RESTORE_LINE)).toBeVisible();
		expect(restoredLines()).toEqual([LOCKED_AFTER_RESTORE_LINE]);
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
