import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import TimelinePage from './+page.svelte';

const { isoFromToday } = vi.hoisted(() => ({
	isoFromToday: (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
}));

// Reactive, as the layout's app object is: the page swaps the card for the list the moment the unlock lands.
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
		calendar: null,
		byok: null,
		cause: null,
		db: {},
		wipeAll: null,
		relockAll: null,
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
const pageHeading = () => page.getByRole('heading', { level: 1, name: 'Timeline' });

describe('Timeline, locked with a PIN', () => {
	// With no saved profile the store reads unlocked after a Lock, but the keys are still gone: the card, not the page.
	it.each([
		['the profile reads locked', true],
		['the profile reads unlocked (nothing saved)', false]
	])('shows the PIN card, not the local panel, when %s', async (_name, storeLocked) => {
		lock.storeLocked = storeLocked;
		const { container } = await render(TimelinePage);

		await expect.element(cardHeading()).toBeVisible();
		await expect.element(pinField()).toBeVisible();
		expect(container.querySelector('.locked-panel')).toBeNull();
	});

	// Local mode is as it was: the one-button panel, no field.
	it('keeps the one-button panel for a lock without a PIN', async () => {
		lock.mode = 'local';
		lock.pinLocked = false;
		const { container } = await render(TimelinePage);

		await expect.element(cardHeading()).toBeVisible();
		expect(container.querySelector('.locked-panel__unlock')).not.toBeNull();
		expect(pinField().query()).toBeNull();
	});

	it('takes the card away and puts focus on the page heading when the unlock lands', async () => {
		await render(TimelinePage);
		await pinField().fill('1234');
		await page.getByRole('button', { name: 'Unlock', exact: true }).click();

		await expect.poll(() => cardHeading().query()).toBeNull();
		await expect.poll(() => document.activeElement).toBe(pageHeading().element());
	});
});
