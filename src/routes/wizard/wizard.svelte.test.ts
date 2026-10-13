import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
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

// Enter as a keyboard sends it: the key, its code and the carriage return it types.
const ENTER = {
	key: 'Enter',
	code: 'Enter',
	windowsVirtualKeyCode: 13,
	text: String.fromCharCode(13)
};

const SAVE = { name: 'Save and continue' } as const;
const SKIP = { name: 'Skip for now' } as const;

// The page with a valid date typed and focus on Save, as a keyboard user who has just finished the field.
async function renderWithFocusOnSave(): Promise<HTMLButtonElement> {
	await render(WizardPage);
	await page.getByLabelText('Separation date').fill(TYPED);
	const save = page.getByRole('button', SAVE).element() as HTMLButtonElement;
	save.focus();
	await expect.poll(() => document.activeElement).toBe(save);
	return save;
}

// A save the test settles by hand, and the point where the page has handed it over.
async function startPendingSave() {
	const pending = pendingSave();
	await submitTypedDate();
	await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
	return pending;
}

// A plain DOM click: on a button that is off it does nothing, where the test driver's own click would wait for the
// button to come back on.
const press = (name: string): void => {
	(page.getByRole('button', { name }).element() as HTMLButtonElement).click();
};

describe('Wizard, the buttons while a save is pending', () => {
	it('leaves Save on, so a button that holds focus keeps it', async () => {
		const { settle } = await startPendingSave();
		const save = page.getByRole('button', SAVE).element() as HTMLButtonElement;
		expect(save.disabled).toBe(false);
		settle({ ok: false, reason: new Error('E_TEST_WRITE') });
		await expect.element(page.getByText(FAILED)).toBeVisible();
	});

	it('turns Skip off, and gives it back once the save has failed', async () => {
		const { settle } = await startPendingSave();
		await expect.element(page.getByRole('button', SKIP)).toBeDisabled();

		settle({ ok: false, reason: new Error('E_TEST_WRITE') });
		await expect.element(page.getByText(FAILED)).toBeVisible();
		await expect.element(page.getByRole('button', SKIP)).toBeEnabled();
	});

	it('does not leave the page for Home when Skip is pressed during a save', async () => {
		const { settle } = await startPendingSave();
		press(SKIP.name);
		await new Promise((r) => setTimeout(r, 50));
		expect(goto).not.toHaveBeenCalledWith('/');

		// Only while the save runs: once it has failed, Skip leaves as it always did.
		settle({ ok: false, reason: new Error('E_TEST_WRITE') });
		await expect.element(page.getByText(FAILED)).toBeVisible();
		await expect.element(page.getByRole('button', SKIP)).toBeEnabled();
		press(SKIP.name);
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/'));
	});
});

// A failed save keeps the keyboard's place on Save: Save is never switched off, since a switched-off button that holds
// focus drops it to the page. Whether a drop would show depends on the save outlasting a frame, so both lengths run.
describe('Wizard, a failed save from the keyboard', () => {
	it.each([
		['fails at once', 0],
		['takes a while to fail', 100]
	] as const)('keeps focus on Save when the save %s', async (_, ms) => {
		store.save.mockImplementation(
			() =>
				new Promise((_resolve, reject) => setTimeout(() => reject(new Error('E_TEST_WRITE')), ms))
		);
		const save = await renderWithFocusOnSave();

		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));

		await expect.element(page.getByText(FAILED)).toBeVisible();
		await expect.poll(() => document.activeElement).toBe(save);
		// Still there a moment later, not only on the frame the line appeared.
		await new Promise((r) => setTimeout(r, 50));
		await expect.poll(() => document.activeElement).toBe(save);
	});

	it('leaves focus where the person moved it during the save', async () => {
		const { settle } = pendingSave();
		const save = await renderWithFocusOnSave();
		const field = page.getByLabelText('Separation date').element() as HTMLInputElement;

		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
		field.focus();
		await expect.poll(() => document.activeElement).toBe(field);

		settle({ ok: false, reason: new Error('E_TEST_WRITE') });
		await expect.element(page.getByText(FAILED)).toBeVisible();
		await new Promise((r) => setTimeout(r, 50));
		expect(document.activeElement).toBe(field);
		expect(document.activeElement).not.toBe(save);
	});

	// A held key repeats about every 40 ms; each repeat that reached Save would send another save. The keys go through
	// the browser's own input, so a repeat is a real one. The save stays pending past 100 ms and across frames.
	it('saves once for a held Enter on Save', async () => {
		const { settle } = pendingSave();
		await renderWithFocusOnSave();

		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		for (let i = 0; i < 5; i++) {
			await new Promise((resolve) => setTimeout(resolve, 40));
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
		}
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));

		settle({ ok: true });
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/timeline'));
		expect(store.save).toHaveBeenCalledTimes(1);
	});
});
