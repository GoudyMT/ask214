import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import WizardPage from './+page.svelte';
import { OccConflictError } from '$lib/profile/store.svelte';

type Patch = { eaos: Uint8Array; setupIntent: string };

const { store, goto } = vi.hoisted(() => ({
	store: {
		save: vi.fn<(patch: Patch) => Promise<unknown>>(),
		refresh: vi.fn<() => Promise<void>>()
	},
	goto: vi.fn<(url: string) => Promise<void>>()
}));

vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({ status: 'ready', store }),
	setProfileApp: () => {}
}));
vi.mock('$app/navigation', () => ({ goto }));

const FAILED = 'Could not update right now - please try again.';
const OCC = 'This was changed in another tab. We reloaded it - please review and save again.';

// A date a few months out, inside the range the page accepts, built from the real clock.
const TYPED = (() => {
	const d = new Date();
	d.setDate(d.getDate() + 120);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

const unhandled: unknown[] = [];
const onUnhandled = (e: PromiseRejectionEvent) => unhandled.push(e.reason);

beforeEach(() => {
	unhandled.length = 0;
	window.addEventListener('unhandledrejection', onUnhandled);
	store.save.mockReset();
	store.refresh.mockReset().mockResolvedValue(undefined);
	goto.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	window.removeEventListener('unhandledrejection', onUnhandled);
});

const allZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);

async function submitTypedDate(): Promise<void> {
	await render(WizardPage);
	await page.getByLabelText('Separation date').fill(TYPED);
	await page.getByRole('button', { name: 'Save and continue' }).click();
}

// A save that stays pending until the test lets it settle, and keeps the bytes it was handed.
function pendingSave() {
	const seen: { eaos: Uint8Array | null; whileSaving: number[] } = { eaos: null, whileSaving: [] };
	let settle!: (outcome: { ok: true } | { ok: false; reason: unknown }) => void;
	const settled = new Promise<{ ok: true } | { ok: false; reason: unknown }>((r) => (settle = r));
	store.save.mockImplementation(async (patch) => {
		seen.eaos = patch.eaos;
		seen.whileSaving = Array.from(patch.eaos);
		const outcome = await settled;
		if (!outcome.ok) throw outcome.reason;
		return { generation: 1 };
	});
	return { seen, settle };
}

describe('Wizard, a save that fails', () => {
	it('says so, keeps the typed date, and leaves no unhandled rejection', async () => {
		store.save.mockRejectedValue(new Error('E_TEST_WRITE'));
		await submitTypedDate();

		await expect.element(page.getByText(FAILED)).toBeVisible();
		await expect.element(page.getByLabelText('Separation date')).toHaveValue(TYPED);
		expect(goto).not.toHaveBeenCalled();
		// The rejection event fires after the microtask that threw; give it a turn before reading the list.
		await new Promise((r) => setTimeout(r, 50));
		expect(unhandled).toEqual([]);
	});

	it('shows the failed line, not the reloaded one, when the re-read after a conflict fails too', async () => {
		store.save.mockRejectedValue(new OccConflictError());
		store.refresh.mockRejectedValue(new Error('E_TEST_READ'));
		await submitTypedDate();

		await expect.element(page.getByText(FAILED)).toBeVisible();
		expect(page.getByText(OCC).query()).toBeNull();
		await new Promise((r) => setTimeout(r, 50));
		expect(unhandled).toEqual([]);
	});

	it('still asks for a review after a conflict it could re-read', async () => {
		store.save.mockRejectedValue(new OccConflictError());
		await submitTypedDate();

		await expect.element(page.getByText(OCC)).toBeVisible();
		expect(store.refresh).toHaveBeenCalledTimes(1);
	});
});

describe('Wizard, the typed date in memory', () => {
	it('is zeroed once a save that worked has settled, not before, and the page moves on', async () => {
		const { seen, settle } = pendingSave();
		await submitTypedDate();

		await vi.waitFor(() => expect(seen.eaos).not.toBeNull());
		expect(seen.whileSaving.some((b) => b !== 0)).toBe(true);
		expect(allZero(seen.eaos as Uint8Array)).toBe(false);
		expect(goto).not.toHaveBeenCalled();

		settle({ ok: true });
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/timeline'));
		await vi.waitFor(() => expect(allZero(seen.eaos as Uint8Array)).toBe(true));
	});

	it('is zeroed once a save that failed has settled, not before', async () => {
		const { seen, settle } = pendingSave();
		await submitTypedDate();

		await vi.waitFor(() => expect(seen.eaos).not.toBeNull());
		expect(allZero(seen.eaos as Uint8Array)).toBe(false);

		settle({ ok: false, reason: new Error('E_TEST_WRITE') });
		await expect.element(page.getByText(FAILED)).toBeVisible();
		await vi.waitFor(() => expect(allZero(seen.eaos as Uint8Array)).toBe(true));
	});
});
