import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import { RESTORE_ENTRY } from '#lib/backup/copy.js';
import WizardPage from './+page.svelte';

// Reactive, as the layout's app object is: the page swaps the card away the moment the unlock lands.
const lock = $state({ pinLocked: true });
vi.mock('#lib/profile/context.js', () => ({
	getProfileApp: () => ({
		status: 'ready',
		keyMode: 'pin',
		get pinLocked() {
			return lock.pinLocked;
		},
		store: null,
		timeline: null,
		byok: null,
		db: {},
		joinRelock: null,
		publish: null,
		reloadOnUnlock: false,
		replacedNotice: false,
		unlockStores: async () => {
			lock.pinLocked = false;
		}
	}),
	setProfileApp: () => {}
}));
// The check itself is the card's own test; here it only has to end well, after one wrong try.
vi.mock('#lib/keystore/app-lock-store.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/keystore/app-lock-store.js')>()),
	readTries: async () => ({ count: 0, waitMs: 0, pending: false }),
	runPinCheck: async () => ({ kind: 'good', value: true, wrongTries: 1, unfinished: false })
}));

beforeEach(() => {
	lock.pinLocked = true;
});

const cardHeading = () => page.getByRole('heading', { name: 'Your data is locked' });
const saveButton = () => page.getByRole('button', { name: 'Save and continue' });
const noticeLines = (region: Element | null) =>
	[...(region?.querySelectorAll('p') ?? [])].map((p) => p.textContent?.trim());

describe('the wizard, locked with a PIN', () => {
	// A saved profile behind a PIN is not a first run: the page asks for the PIN, as every locked page does, and offers no
	// form whose save could only fail. After the unlock the person is told the tries before it, and focus is not dropped.
	it('shows the Unlock card in place of the form and the restore, then the tries notice and the form after a good PIN', async () => {
		const { container } = await render(WizardPage);
		await expect.element(cardHeading()).toBeVisible();
		expect(saveButton().query()).toBeNull();
		expect(page.getByText(RESTORE_ENTRY).query()).toBeNull();
		const region = container.querySelector('.wizard-notice');
		expect(region?.getAttribute('role')).toBe('status');
		expect(noticeLines(region)).toEqual([]);

		await page.getByLabelText('PIN', { exact: true }).fill('1234');
		await page.getByRole('button', { name: 'Unlock', exact: true }).click();

		await expect.poll(() => cardHeading().query()).toBeNull();
		await expect.element(saveButton()).toBeVisible();
		expect(container.querySelector('.wizard-notice')).toBe(region);
		expect(noticeLines(region)).toEqual(['1 wrong PIN try since your last unlock.']);
		await expect
			.poll(() => document.activeElement)
			.toBe(page.getByRole('heading', { level: 1, name: 'Set up your profile' }).element());
	});
});
