import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import HomePage from './+page.svelte';

// Home runs the real Ask store; only what leaves the page or needs a worker is replaced, as in the other Home tests.
vi.mock('$lib/ask', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/ask')>()),
	createRecoveringEmbed: () => ({ embed: async () => [], dispose: () => {} })
}));
vi.mock('$lib/ask/embed-worker?worker', () => ({ default: class {} }));
vi.mock('$lib/ask/device-files', () => ({ deviceFilesKept: async () => true }));
vi.mock('$lib/install/context', () => ({
	getInstallApp: () => ({ canPrompt: false, installed: true, ios: false, persisted: false }),
	setInstallApp: () => {}
}));

// Reactive, as the layout's app object is: the page swaps the card away the moment the unlock lands.
const lock = $state({ pinLocked: true });
vi.mock('$lib/profile/context', () => ({
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
	lock.pinLocked = true;
});

const cardHeading = () => page.getByRole('heading', { name: 'Your data is locked' });
const noticeLines = (region: Element | null) =>
	[...(region?.querySelectorAll('p') ?? [])].map((p) => p.textContent?.trim());

async function unlockOnce(): Promise<void> {
	await page.getByLabelText('PIN', { exact: true }).fill('1234');
	await page.getByRole('button', { name: 'Unlock', exact: true }).click();
	await expect.poll(() => cardHeading().query()).toBeNull();
}

describe('Home, locked with a PIN', () => {
	// The person is told what the tries before this good PIN were, where the card stood. The region is on the page before
	// its lines arrive, so a screen reader is already listening, and the next unlock replaces what it said.
	it('tells the person the wrong tries before a good PIN in a status region that was already there, and the next unlock replaces it', async () => {
		before.wrongTries = 1;
		const { container } = await render(HomePage);
		await expect.element(cardHeading()).toBeVisible();
		const region = container.querySelector('.home-notice');
		expect(region?.getAttribute('role')).toBe('status');
		expect(noticeLines(region)).toEqual([]);

		await unlockOnce();
		expect(container.querySelector('.home-notice')).toBe(region);
		expect(noticeLines(region)).toEqual(['1 wrong PIN try since your last unlock.']);

		before.wrongTries = 0;
		lock.pinLocked = true;
		await expect.element(cardHeading()).toBeVisible();
		await unlockOnce();
		expect(container.querySelector('.home-notice')).toBe(region);
		expect(noticeLines(region)).toEqual([]);
	});

	// A Lock ends the visit the notice was about: it must not sit above "Your data is locked", and the same tries after the
	// next unlock are news again, so the line has to arrive as a new node for a screen reader to speak it.
	it('empties the notice when the page locks, and brings the same notice back as a new line after the next unlock', async () => {
		before.wrongTries = 1;
		const { container } = await render(HomePage);
		const region = container.querySelector('.home-notice');
		await unlockOnce();
		expect(noticeLines(region)).toEqual(['1 wrong PIN try since your last unlock.']);

		lock.pinLocked = true;
		await expect.element(cardHeading()).toBeVisible();
		expect(container.querySelector('.home-notice')).toBe(region);
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
			.toEqual(['1 wrong PIN try since your last unlock.']);
		watch.disconnect();
		expect(arrived).toEqual(['1 wrong PIN try since your last unlock.']);
	});
});
