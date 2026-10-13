import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { AskState } from '$lib/ask';
import HomePage from './+page.svelte';

// The Ask store is replaced by one the test controls, and the cache read that makes it is held until `landStore()`.
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
	getProfileApp: () => ({ status: 'loading', store: null, byok: null }),
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

	it('ignores a second Enter just after its Dismiss hands focus to the field', async () => {
		await ready();
		await userEvent.keyboard('{Enter}');
		await pause(50);

		expect(asks).not.toHaveBeenCalled();
	});

	it('asks on a second Enter once the guard has ended', async () => {
		await ready();
		await pause(600);
		await userEvent.keyboard('{Enter}');

		await expect.poll(() => asks.mock.calls).toEqual([['how do I file a claim']]);
	});
});
