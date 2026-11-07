import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import WizardPage from './+page.svelte';
import { OccConflictError } from '#lib/profile/store.svelte.js';

type Patch = { eaos: Uint8Array; setupIntent: string };

const { store, goto } = vi.hoisted(() => ({
	store: {
		save: vi.fn<(patch: Patch) => Promise<unknown>>(),
		refresh: vi.fn<() => Promise<void>>()
	},
	goto: vi.fn<(url: string) => Promise<void>>()
}));

vi.mock('#lib/profile/context.js', () => ({
	getProfileApp: () => ({
		status: 'ready',
		store,
		joinRelock: null,
		publish: null,
		reloadOnUnlock: false,
		replacedNotice: false
	}),
	setProfileApp: () => {}
}));
vi.mock('$app/navigation', () => ({ goto }));

const FAILED = 'Could not update right now - please try again.';
const OCC = 'This was changed in another tab. We reloaded it - please review and save again.';

// A date this many days from today, built from the real clock.
const daysFromToday = (days: number): string => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A date a few months out, inside the range the page accepts.
const TYPED = daysFromToday(120);

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

// The range runs back 5 years as well as forward 15, so the line names both ends: a year typo in either direction was
// told only one of them. Settings and the E2E suite pin the same words.
describe('Wizard, a date outside the range', () => {
	it('names both ends of the range when the date is too far back, and saves nothing', async () => {
		await render(WizardPage);
		await page.getByLabelText('Separation date').fill(daysFromToday(-6 * 365));
		await page.getByRole('button', { name: 'Save and continue' }).click();

		await expect
			.element(page.getByText('Enter a date from 5 years ago to 15 years from now.'))
			.toBeVisible();
		expect(store.save).not.toHaveBeenCalled();
		expect(goto).not.toHaveBeenCalled();
	});
});

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

// Each branch names this date differently (ETS, EAOS, DOS), and orders come late, so the hint names the day itself
// and who to ask. "Service", not "active duty": a Guard or Reserve member leaving their own component uses it too.
describe('Wizard, the separation date hint', () => {
	it('describes the date in words every branch and component uses', async () => {
		await render(WizardPage);
		await expect
			.element(page.getByLabelText('Separation date'))
			.toHaveAccessibleDescription(
				'The day your service is set to end. Ask your personnel office if you are not sure.'
			);
	});
});

describe('Wizard, how the member is leaving', () => {
	const decode = (bytes: Uint8Array | undefined) =>
		bytes ? new TextDecoder().decode(bytes) : undefined;
	const lastPatch = () =>
		store.save.mock.calls.at(-1)?.[0] as Patch & { separationPath?: Uint8Array };

	it('asks it as an optional group of six choices in order, with its hint', async () => {
		await render(WizardPage);
		const group = page.getByRole('radiogroup', { name: 'How are you leaving? (optional)' });
		await expect
			.element(group)
			.toHaveAccessibleDescription('This adds the steps for your path. It stays on this device.');
		// The two retiring answers sit side by side and each names its component, so neither reads as the other's.
		const choices = [
			'Finishing my service',
			'Retiring from active duty',
			'Retiring from the Guard or Reserve',
			'A medical board',
			'Leaving the Guard or Reserve',
			'Not sure yet'
		];
		for (const choice of choices) {
			await expect
				.element(group.getByRole('radio', { name: choice, exact: true }))
				.not.toBeChecked();
		}
		expect(
			group
				.getByRole('radio')
				.elements()
				.map((radio) => radio.closest('label')?.textContent?.trim())
		).toEqual(choices);
	});

	it('saves the picked path with the date, in one save, and wipes its bytes once it settles', async () => {
		// Read while the save runs: the page wipes its copy of the bytes once the save has settled, as it does the date.
		let seen: string | undefined;
		store.save.mockImplementation(async (patch) => {
			seen = decode((patch as Patch & { separationPath?: Uint8Array }).separationPath);
			return { generation: 1 };
		});
		await render(WizardPage);
		await page.getByRole('radio', { name: 'A medical board' }).click();
		await page.getByLabelText('Separation date').fill(TYPED);
		await page.getByRole('button', { name: 'Save and continue' }).click();
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/timeline'));
		expect(store.save).toHaveBeenCalledTimes(1);
		expect(seen).toBe('medical');
		expect(lastPatch().setupIntent).toBe('completed');
		expect(allZero(lastPatch().separationPath as Uint8Array)).toBe(true);
	});

	// Another tab can save an answer after this one opened; a member who picked nothing here has said nothing about it.
	it('leaves a saved answer alone when nothing is picked', async () => {
		store.save.mockResolvedValue({ generation: 1 });
		await render(WizardPage);
		await page.getByLabelText('Separation date').fill(TYPED);
		await page.getByRole('button', { name: 'Save and continue' }).click();
		await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
		expect('separationPath' in lastPatch()).toBe(false);
	});

	it.each([
		['Not sure yet', 'Not sure yet'],
		['Not sure yet after another pick', 'Retiring from active duty']
	])('clears any earlier path for %s', async (_name, first) => {
		// The store merges a patch over the saved record, so only a present-but-empty key clears an answer saved
		// before (a member who came Back to this page, or another tab that set it up first).
		store.save.mockResolvedValue({ generation: 1 });
		await render(WizardPage);
		await page.getByRole('radio', { name: first, exact: true }).click();
		if (first === 'Retiring from active duty')
			await page.getByRole('radio', { name: 'Not sure yet' }).click();
		await expect.element(page.getByRole('radio', { name: 'Not sure yet' })).toBeChecked();
		await page.getByLabelText('Separation date').fill(TYPED);
		await page.getByRole('button', { name: 'Save and continue' }).click();
		await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
		expect('separationPath' in lastPatch()).toBe(true);
		expect(lastPatch().separationPath).toBeUndefined();
	});

	it('wipes the picked path bytes when the save fails too', async () => {
		store.save.mockRejectedValue(new Error('E_TEST'));
		await render(WizardPage);
		await page.getByRole('radio', { name: 'Retiring from active duty', exact: true }).click();
		await page.getByLabelText('Separation date').fill(TYPED);
		await page.getByRole('button', { name: 'Save and continue' }).click();
		await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(allZero(lastPatch().separationPath as Uint8Array)).toBe(true));
		expect(goto).not.toHaveBeenCalled();
	});

	// Component tests run without app.css, so the pill cases set its spacing and border tokens as the app defines them
	// (an undefined border colour drops the whole border), and remove them.
	const TOKENS = {
		'--space-xs': '4px',
		'--space-s': '8px',
		'--space-m': '16px',
		'--space-l': '24px',
		'--color-border': '#2a313a'
	};
	async function withSpacing(run: () => Promise<void>): Promise<void> {
		const root = document.documentElement;
		for (const [name, value] of Object.entries(TOKENS)) root.style.setProperty(name, value);
		try {
			await run();
		} finally {
			for (const name of Object.keys(TOKENS)) root.style.removeProperty(name);
		}
	}

	// At large text a long choice wraps to two lines inside its pill; with no padding above and below, the lines touch
	// the pill's edge.
	it('keeps space between a choice and its pill edge at 200% text', () =>
		withSpacing(async () => {
			const root = document.documentElement;
			const before = root.style.fontSize;
			root.style.fontSize = '200%';
			try {
				await render(WizardPage);
				const pill = page
					.getByRole('radio', { name: 'Retiring from the Guard or Reserve' })
					.element()
					.closest('label') as Element;
				// The text's own box against the pill's inner edge, as drawn: the 44 px floor alone leaves ~2 px here.
				const box = pill.getBoundingClientRect();
				const text = (pill.querySelector('span') as Element).getBoundingClientRect();
				const border = parseFloat(getComputedStyle(pill).borderTopWidth);
				expect(text.top - box.top - border).toBeGreaterThanOrEqual(4);
				expect(box.bottom - text.bottom - border).toBeGreaterThanOrEqual(4);
			} finally {
				root.style.fontSize = before;
			}
		}));

	// In forced colors the pick is a thicker border; a pill that grew with it would push the others along the row.
	it('keeps a pill the same size when it is picked in forced colors', () =>
		withSpacing(async () => {
			await cdp().send('Emulation.setEmulatedMedia', {
				features: [{ name: 'forced-colors', value: 'active' }]
			});
			try {
				await render(WizardPage);
				const radio = page.getByRole('radio', { name: 'A medical board' });
				const pill = radio.element().closest('label') as Element;
				const before = pill.getBoundingClientRect();
				await radio.click();
				await expect.element(radio).toBeChecked();
				const after = pill.getBoundingClientRect();
				expect([after.width, after.height]).toEqual([before.width, before.height]);
			} finally {
				await cdp().send('Emulation.setEmulatedMedia', { features: [] });
			}
		}));

	// A touch screen keeps the last tapped pill hovered; on a device that cannot hover, a hovered pill keeps its border.
	it('draws no hover border on a device that cannot hover', () =>
		withSpacing(async () => {
			const root = document.documentElement;
			root.style.setProperty('--color-accent', '#0b5cad');
			// A phone as the browser's device mode makes it: touch points, so the page reads "(hover: none)".
			await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
			try {
				await render(WizardPage);
				expect(matchMedia('(hover: none)').matches).toBe(true);
				const radio = page.getByRole('radio', { name: 'A medical board' });
				const pill = radio.element().closest('label') as Element;
				const resting = getComputedStyle(pill).borderTopColor;
				await radio.hover();
				expect(getComputedStyle(pill).borderTopColor).toBe(resting);
			} finally {
				root.style.removeProperty('--color-accent');
				await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: false });
			}
		}));

	// A member may press Enter on a choice expecting it to act: setup is saved only from the Save button or the date
	// field, so Enter on a choice saves nothing.
	it('does not save on Enter on a choice', async () => {
		store.save.mockResolvedValue({ generation: 1 });
		await render(WizardPage);
		await page.getByLabelText('Separation date').fill(TYPED);
		const radio = page.getByRole('radio', { name: 'A medical board' });
		await radio.click();
		(radio.element() as HTMLElement).focus();
		await cdp().send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		await cdp().send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(store.save).not.toHaveBeenCalled();
		await expect.element(radio).toBeChecked();
	});

	it('saves nothing when the member skips, whatever was picked', async () => {
		await render(WizardPage);
		await page.getByRole('radio', { name: 'Retiring from active duty', exact: true }).click();
		await page.getByRole('button', { name: 'Skip for now' }).click();
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/'));
		expect(store.save).not.toHaveBeenCalled();
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
		expect(save.getAttribute('aria-busy')).toBe('true');
		settle({ ok: false, reason: new Error('E_TEST_WRITE') });
		await expect.element(page.getByText(FAILED)).toBeVisible();
		expect(save.getAttribute('aria-busy')).toBe('false');
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

	// A save that fails inside the hold leaves the form up, so the repeats after it would save again; only a new press
	// does.
	it.each([
		['at once', 0],
		['after a while', 100]
	] as const)('saves once for a held Enter on Save when the save fails %s', async (_, ms) => {
		store.save.mockImplementation(
			() =>
				new Promise((_resolve, reject) => setTimeout(() => reject(new Error('E_TEST_WRITE')), ms))
		);
		const save = await renderWithFocusOnSave();

		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		for (let i = 0; i < 15; i++) {
			await new Promise((resolve) => setTimeout(resolve, 40));
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
		}
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await expect.element(page.getByText(FAILED)).toBeVisible();
		await new Promise((resolve) => setTimeout(resolve, ms + 50));
		expect(store.save).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(save);

		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(2));
	});
});
