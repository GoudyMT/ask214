import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';

const { isoFromToday } = vi.hoisted(() => ({
	isoFromToday: (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}
}));

// Reactive, as the layout's app object is: the hint and the row's summary follow the mode.
const state = $state({
	mode: 'local' as 'local' | 'pin',
	completeness: 'eaos-only' as 'eaos-only' | 'none'
});
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		get keyMode() {
			return state.mode;
		},
		pinLocked: false,
		store: {
			locked: false,
			load: async () => {},
			clockBackward: false,
			get persona() {
				return state.completeness === 'none'
					? { completeness: 'none' }
					: { completeness: 'eaos-only', eaos: isoFromToday(200), daysUntilSeparation: 200 };
			}
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
		relockAll: () => {},
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

// A device with no profile can still hold saved documents, and then its Privacy and security section has the Erase alone.
const docs = vi.hoisted(() => ({ held: false }));
vi.mock('$lib/sources/document-states', () => ({
	documentStates: () => (docs.held ? { 'a-saved-document': { state: 'saved', stale: [] } } : {})
}));

const LOCAL_HINT = 'Clears your profile from this screen. Use Unlock to view it again.';
const PIN_HINT = 'Locks your saved information now.';

beforeEach(() => {
	state.mode = 'local';
	state.completeness = 'eaos-only';
	docs.held = false;
});

const row = () => page.getByRole('button', { name: 'App lock' });
const text = (line: string) => page.getByText(line, { exact: true });

describe('Settings, App lock', () => {
	it('shows the row in Privacy and security, above Lock, reading Off', async () => {
		await render(SettingsPage);

		await expect.element(row()).toBeVisible();
		expect(row().element().textContent).toContain('Off');
		const toggle = row().element();
		const lock = page.getByRole('button', { name: 'Lock', exact: true }).element();
		expect(toggle.compareDocumentPosition(lock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	// The row moves the saved records onto new keys, so it needs a profile to move; a device with none has nothing to lock.
	it('shows no row, and no Lock, without a profile', async () => {
		state.completeness = 'none';
		await render(SettingsPage);

		await expect.element(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
		expect(row().query()).toBeNull();
		expect(page.getByRole('button', { name: 'Lock', exact: true }).query()).toBeNull();
	});

	it('shows no row, but still the Erase, on a device that holds only saved documents', async () => {
		state.completeness = 'none';
		docs.held = true;
		await render(SettingsPage);

		await expect
			.element(page.getByRole('button', { name: 'Erase all data on this device' }))
			.toBeVisible();
		expect(row().query()).toBeNull();
	});

	it.each([
		['local', LOCAL_HINT, PIN_HINT],
		['pin', PIN_HINT, LOCAL_HINT]
	] as const)('under a %s lock, the Lock hint reads its own line', async (mode, shown, absent) => {
		state.mode = mode;
		await render(SettingsPage);

		await expect.element(text(shown)).toBeVisible();
		expect(text(absent).query()).toBeNull();
	});
});
