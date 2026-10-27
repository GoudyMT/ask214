import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import TimelinePage from './+page.svelte';
import { captureBackupIntent, markBackupIntent } from '$lib/backup/intent';
import { backupSession } from '$lib/backup/session.svelte';

// A client navigation cannot run in the test page; the page's request to go to Settings is recorded instead.
const nav = vi.hoisted(() => ({ goto: vi.fn<(url: string) => Promise<void>>(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: nav.goto
}));

const { isoFromToday, byok } = vi.hoisted(() => ({
	// The stored API key, which only an unlocked tab may read.
	byok: { readApiKey: vi.fn(async () => null as string | null) },
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
		byok,
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
	byok.readApiKey.mockClear();
	nav.goto.mockClear();
	backupSession.takeEraseRequest();
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

	// After a restore the page looks for the stored API key to say whether it must be added again. With no keys that read
	// is not the page's to make, and a store that reads unlocked (nothing saved) must not let it through.
	it.each([
		['is PIN-locked with nothing saved', 0, true],
		['is unlocked', 1, false]
	])(
		'after a restore, a tab that %s reads the stored API key %i times',
		async (_name, reads, pinLocked) => {
			lock.pinLocked = pinLocked;
			lock.storeLocked = false;
			markBackupIntent('restored', location.pathname);
			captureBackupIntent();
			await render(TimelinePage);
			await expect
				.element(
					pinLocked ? cardHeading() : page.getByRole('heading', { level: 1, name: 'Timeline' })
				)
				.toBeVisible();
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(byok.readApiKey).toHaveBeenCalledTimes(reads);
		}
	);

	// The Erase lives in Settings, so the card's Erase and start over sets the request the Settings page opens its dialog on,
	// and moves there: the way the setup screen does.
	it('Forgot PIN, then Erase and start over, asks Settings to open its Erase dialog and goes there', async () => {
		await render(TimelinePage);

		await page.getByRole('button', { name: 'Forgot PIN?', exact: true }).click();
		await page.getByRole('button', { name: 'Erase and start over', exact: true }).click();

		await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/settings'));
		expect(nav.goto).toHaveBeenCalledTimes(1);
		expect(backupSession.takeEraseRequest()).toBe(true);
		expect(backupSession.takeEraseRequest()).toBe(false);
	});

	it('takes the card away and puts focus on the page heading when the unlock lands', async () => {
		await render(TimelinePage);
		await pinField().fill('1234');
		await page.getByRole('button', { name: 'Unlock', exact: true }).click();

		await expect.poll(() => cardHeading().query()).toBeNull();
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
		before.wrongTries = 3;
		const { container } = await render(TimelinePage);
		const region = container.querySelector('.timeline-notice');
		expect(region?.getAttribute('role')).toBe('status');
		expect(noticeLines(region)).toEqual([]);

		await unlockOnce();
		expect(container.querySelector('.timeline-notice')).toBe(region);
		expect(noticeLines(region)).toEqual(['3 wrong PIN tries since your last unlock.']);

		before.wrongTries = 0;
		lock.pinLocked = true;
		lock.storeLocked = true;
		await expect.element(cardHeading()).toBeVisible();
		await unlockOnce();
		expect(container.querySelector('.timeline-notice')).toBe(region);
		expect(noticeLines(region)).toEqual([]);
	});

	// A Lock ends the visit the notice was about: it must not sit above "Your data is locked", and the same tries after the
	// next unlock are news again, so the line has to arrive as a new node for a screen reader to speak it.
	it('empties the notice when the page locks, and brings the same notice back as a new line after the next unlock', async () => {
		before.wrongTries = 3;
		const { container } = await render(TimelinePage);
		const region = container.querySelector('.timeline-notice');
		await unlockOnce();
		expect(noticeLines(region)).toEqual(['3 wrong PIN tries since your last unlock.']);

		lock.pinLocked = true;
		lock.storeLocked = true;
		await expect.element(cardHeading()).toBeVisible();
		expect(container.querySelector('.timeline-notice')).toBe(region);
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
});
