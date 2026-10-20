import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { AskState } from '$lib/ask';
import HomePage from './+page.svelte';

// The Ask store is replaced by one the test controls, and the cache read that makes it is held until `gate.land()`.
const gate = vi.hoisted(() => ({ land: () => {}, held: Promise.resolve(true) }));
const fake = $state<{ state: AskState; mode: 'device' | 'online' }>({
	state: { kind: 'idle' },
	mode: 'online'
});
const asks = vi.fn();
const store = {
	get state() {
		return fake.state;
	},
	get mode() {
		return fake.mode;
	},
	showNudge: false,
	// As the real store's ask does for a question: the view leaves idle at once.
	ask: async (query: string) => {
		asks(query);
		fake.state = { kind: 'embedding' };
	},
	setMode: (m: 'device' | 'online') => (fake.mode = m),
	setUp: async () => {},
	dismissSetup: () => {},
	consentOnline: async () => {},
	stayOnDevice: async () => {},
	dismissNudge: () => {}
};

vi.mock('$lib/ask', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/ask')>()),
	createAskStore: () => store,
	createRecoveringEmbed: () => ({ embed: async () => [], dispose: () => {} })
}));
vi.mock('$lib/ask/embed-worker?worker', () => ({ default: class {} }));
vi.mock('$lib/ask/device-files', () => ({ deviceFilesKept: () => gate.held }));
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'loading',
		store: null,
		byok: null,
		joinRelock: null,
		publish: null,
		reloadOnUnlock: false,
		replacedNotice: false
	}),
	setProfileApp: () => {}
}));
vi.mock('$lib/install/context', () => ({
	getInstallApp: () => ({
		canPrompt: true,
		installed: false,
		ios: false,
		persisted: false,
		promptInstall: async () => 'dismissed'
	}),
	setInstallApp: () => {}
}));

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const field = () => document.querySelector<HTMLInputElement>('.ask-input');

beforeEach(() => {
	fake.state = { kind: 'idle' };
	fake.mode = 'online';
	asks.mockClear();
	localStorage.removeItem('mtc:install-nudge-dismissed');
	gate.held = new Promise<boolean>((resolve) => (gate.land = () => resolve(true)));
});

const pill = () => document.querySelector<HTMLButtonElement>('.q-feed__pill')!;

describe('Home, a feed question pressed before the Ask store exists', () => {
	it('hands focus to the field once the store asks it, after a keyboard press', async () => {
		await render(HomePage);
		pill().focus();
		await userEvent.keyboard('{Enter}');
		expect(document.activeElement).toBe(pill());
		const text = pill().textContent?.trim();

		gate.land();
		await expect.poll(() => asks.mock.calls).toEqual([[text]]);
		await expect.poll(() => document.activeElement).toBe(field());
	});

	it('moves no focus to the field after a tap', async () => {
		await render(HomePage);
		await userEvent.click(pill());

		gate.land();
		await expect.poll(() => asks.mock.calls.length).toBe(1);
		await vi.waitFor(() => expect(document.querySelector('.q-feed')).toBeNull());
		await pause(50);
		expect(document.activeElement).not.toBe(field());
	});
});

describe('Home, the install nudge', () => {
	const ready = async () => {
		await render(HomePage);
		gate.land();
		await expect.element(page.getByRole('button', { name: 'Search' })).toBeEnabled();
		const input = field()!;
		input.value = 'how do I file a claim';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		document.querySelector<HTMLButtonElement>('.install-nudge__dismiss')?.focus();
		await userEvent.keyboard('{Enter}');
		await expect.poll(() => document.activeElement).toBe(input);
	};

	it('ignores a second Enter soon after its Dismiss hands focus to the field', async () => {
		// The guard reads the clock, and on a slow machine the test browser's own delays can push a real 300 ms past it.
		// Only Date is faked, so the time the guard sees between the hand-off and the key is exactly what is set here.
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			await ready();
			// Well inside the guard, but long enough that a guard too short for a real double press would let it through.
			vi.setSystemTime(Date.now() + 300);
			await userEvent.keyboard('{Enter}');
			await pause(50);

			expect(asks).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('asks on a second Enter once the guard has ended', async () => {
		await ready();
		await pause(600);
		await userEvent.keyboard('{Enter}');

		await expect.poll(() => asks.mock.calls).toEqual([['how do I file a claim']]);
	});
});
