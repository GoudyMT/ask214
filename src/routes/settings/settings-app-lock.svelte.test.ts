import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import { backupSession } from '$lib/backup/session.svelte';
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
	completeness: 'eaos-only' as 'eaos-only' | 'none',
	// With a relock set the page shows its own backup card, and the setup's backup card can start.
	joinable: false
});
// What joined the app's relock list; every app object the page, the row and the cards ask for shares it.
const relock = vi.hoisted(() => ({
	list: [] as { relockSync: (reason: string) => void }[],
	join: (r: { relockSync: (reason: string) => void }) => {
		relock.list.push(r);
		return () => {
			relock.list.splice(relock.list.indexOf(r), 1);
		};
	}
}));
// The PIN's Argon2id lives in a worker: a fixed pair of keys answers for it. The rest of the module is the real one.
vi.mock('$lib/keystore/pin-derive', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/keystore/pin-derive')>();
	return {
		...real,
		derivePinKeys: async () => ({
			macKey: await crypto.subtle.importKey(
				'raw',
				new Uint8Array(32).fill(7),
				{ name: 'HMAC', hash: 'SHA-256', length: 256 },
				false,
				['sign', 'verify']
			),
			kek: await crypto.subtle.importKey(
				'raw',
				new Uint8Array(32).fill(9),
				{ name: 'AES-KW' },
				false,
				['wrapKey', 'unwrapKey']
			)
		})
	};
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
		get joinRelock() {
			return state.joinable ? relock.join : null;
		},
		publish: null,
		reloadOnUnlock: false,
		replacedNotice: false
	}),
	setProfileApp: () => {}
}));
// The real row, drawn as it is; the wrapper only keeps the props the page mounted it with.
const mounted = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock('$lib/components/AppLockRow.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/components/AppLockRow.svelte')>();
	const mount = real.default as unknown as (
		anchor: unknown,
		props: Record<string, unknown>
	) => unknown;
	return {
		...real,
		default: (anchor: unknown, props: Record<string, unknown>) => {
			mounted.rows.push(props);
			return mount(anchor, props);
		}
	};
});
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
	mounted.rows.length = 0;
	state.mode = 'local';
	state.completeness = 'eaos-only';
	state.joinable = false;
	docs.held = false;
});

afterEach(() => {
	// The backup session is the tab's one: a test that started it must not leave it running for the next.
	backupSession.relockSync('user');
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

	// The setup's backup card has a damaged-device line that offers the Erase: the row must reach the page's own dialog.
	it("gives the row the page's Erase opener, which opens the Erase dialog", async () => {
		await render(SettingsPage);
		await expect.element(row()).toBeVisible();

		const onerase = mounted.rows[0]?.onerase;
		expect(typeof onerase).toBe('function');
		(onerase as () => void)();
		await expect.element(page.getByRole('dialog')).toBeVisible();
		await expect.element(page.getByText('Erase all data on this device?')).toBeVisible();
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

// The page's own Backup card and the PIN setup's backup card draw from the tab's one backup session: both on the page would
// show the words twice, under the same ids.
describe("Settings, the PIN setup's backup step", () => {
	const makeToggles = () => [...document.querySelectorAll('#backup-toggle-export')];
	const makeBodies = () => document.querySelectorAll('#backup-make');
	const pageCard = () => page.getByRole('region', { name: 'Backup', exact: true });
	const button = (name: string) => page.getByRole('button', { name, exact: true });

	async function toStepCard(): Promise<void> {
		await row().click();
		await page.getByLabelText('Choose a 4-6 digit PIN', { exact: true }).fill('1234');
		await page.getByLabelText('Enter it again', { exact: true }).fill('1234');
		await button('Next').click();
		await button('Make a backup and turn on').click();
	}

	it("keeps one backup card on the page while the step makes its backup, and brings the page's back after", async () => {
		state.joinable = true;
		await render(SettingsPage);
		await expect.element(pageCard()).toBeVisible();
		expect(makeToggles()).toHaveLength(1);

		await toStepCard();

		await expect.element(page.getByRole('button', { name: 'Show my passphrase' })).toBeVisible();
		expect(makeToggles()).toHaveLength(1);
		expect(makeBodies()).toHaveLength(1);
		expect(makeToggles()[0]?.textContent).toContain('Make a backup and turn on');
		expect(pageCard().query()).toBeNull();

		// Closing the row ends the step: the page's own card is back, and the step's session did not survive it.
		await row().click();
		await expect.element(pageCard()).toBeVisible();
		expect(makeToggles()).toHaveLength(1);
		expect(makeToggles()[0]?.textContent).not.toContain('turn on');
		expect(backupSession.active).toBe(false);
	});
});
