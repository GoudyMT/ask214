import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import type { ComponentProps } from 'svelte';
import SeparationPathRow from './SeparationPathRow.svelte';

// Enter as a keyboard sends it: the key, its code and the carriage return it types.
const ENTER = {
	key: 'Enter',
	code: 'Enter',
	windowsVirtualKeyCode: 13,
	text: String.fromCharCode(13)
};
const FAILED = 'Could not update right now - please try again.';

const row = async (over: Partial<ComponentProps<typeof SeparationPathRow>> = {}) =>
	await render(SeparationPathRow, {
		props: {
			value: undefined,
			onSave: vi.fn(async () => null),
			onRemove: vi.fn(async () => null),
			...over
		}
	});
const toggle = () => page.getByRole('button', { name: /how you are leaving/i });
const saveButton = () => page.getByRole('button', { name: 'Save', exact: true });

describe('SeparationPathRow', () => {
	it('shows Not answered, or the saved answer in words', async () => {
		await row();
		await expect.element(toggle()).toHaveTextContent('How you are leaving Not answered');
		await row({ value: 'reserve-component' });
		await expect
			.element(page.getByRole('button', { name: /leaving the guard or reserve/i }))
			.toBeVisible();
	});

	it('saves the picked answer, closes, and returns focus to the row', async () => {
		const onSave = vi.fn(async () => null);
		await row({ onSave });
		await toggle().click();
		await page.getByRole('radio', { name: 'Retiring', exact: true }).click();
		await saveButton().click();
		await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith('retirement'));
		await expect.element(toggle()).toHaveAttribute('aria-expanded', 'false');
		expect(document.activeElement).toBe(toggle().element());
	});

	it('saves a Guard or Reserve retirement as its own answer and shows it in words', async () => {
		const onSave = vi.fn(async () => null);
		await row({ onSave });
		await toggle().click();
		await page.getByRole('radio', { name: 'Retiring from the Guard or Reserve' }).click();
		await saveButton().click();
		await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith('reserve-retirement'));
		await row({ value: 'reserve-retirement' });
		await expect
			.element(page.getByRole('button', { name: /retiring from the guard or reserve/i }))
			.toBeVisible();
	});

	it('opens on the saved answer, and Not sure yet saves no answer', async () => {
		const onSave = vi.fn(async () => null);
		await row({ value: 'medical', onSave });
		await toggle().click();
		await expect.element(page.getByRole('radio', { name: 'A medical board' })).toBeChecked();
		await page.getByRole('radio', { name: 'Not sure yet' }).click();
		await saveButton().click();
		await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith(undefined));
	});

	it('offers no Remove answer when nothing is saved', async () => {
		await row();
		await toggle().click();
		await expect
			.element(page.getByRole('button', { name: 'Remove answer' }))
			.not.toBeInTheDocument();
	});

	it('removes a saved answer with Remove answer', async () => {
		const onRemove = vi.fn(async () => null);
		await row({ value: 'ets', onRemove });
		await toggle().click();
		await page.getByRole('button', { name: 'Remove answer' }).click();
		await vi.waitFor(() => expect(onRemove).toHaveBeenCalledOnce());
	});

	// A save writes a new profile version, tells the other tabs and marks the backup out of date.
	it.each([
		['nothing saved and nothing picked', undefined, null],
		['nothing saved and Not sure yet picked', undefined, 'Not sure yet'],
		['the saved answer still picked', 'medical', null]
	] as const)('closes without saving for %s', async (_name, value, pick) => {
		const onSave = vi.fn(async () => null);
		await row({ value, onSave });
		await toggle().click();
		if (pick) await page.getByRole('radio', { name: pick }).click();
		await saveButton().click();
		await expect.element(toggle()).toHaveAttribute('aria-expanded', 'false');
		expect(onSave).not.toHaveBeenCalled();
	});

	// The form closes when a save lands, so a pick taken while it runs would be dropped unseen.
	it('holds the choices while a save runs', async () => {
		let settle: (v: string | null) => void = () => {};
		const onSave = vi.fn(() => new Promise<string | null>((resolve) => (settle = resolve)));
		await row({ onSave });
		await toggle().click();
		await page.getByRole('radio', { name: 'Retiring', exact: true }).click();
		await saveButton().click();
		await page.getByRole('radio', { name: 'A medical board' }).click();
		await expect.element(page.getByRole('radio', { name: 'Retiring', exact: true })).toBeChecked();
		await expect.element(page.getByRole('radio', { name: 'A medical board' })).not.toBeChecked();
		settle(null);
		await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith('retirement'));
	});

	// While one action runs, the other two would close the form or write again under it: a remove landing after a save
	// would undo the answer just saved, and Cancel would close away the line a failure needs.
	it('turns off Remove and Cancel while a save runs', async () => {
		let settle: (v: string | null) => void = () => {};
		const onSave = vi.fn(() => new Promise<string | null>((resolve) => (settle = resolve)));
		const onRemove = vi.fn(async () => null);
		await row({ value: 'ets', onSave, onRemove });
		await toggle().click();
		await page.getByRole('radio', { name: 'Retiring', exact: true }).click();
		await saveButton().click();
		await expect.element(page.getByRole('button', { name: 'Remove answer' })).toBeDisabled();
		await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeDisabled();
		settle(null);
		await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		expect(onRemove).not.toHaveBeenCalled();
	});

	it('turns off Save and Cancel while a remove runs', async () => {
		let settle: (v: string | null) => void = () => {};
		const onRemove = vi.fn(() => new Promise<string | null>((resolve) => (settle = resolve)));
		const onSave = vi.fn(async () => null);
		await row({ value: 'ets', onSave, onRemove });
		await toggle().click();
		await page.getByRole('button', { name: 'Remove answer' }).click();
		await expect.element(saveButton()).toBeDisabled();
		await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeDisabled();
		settle(null);
		await vi.waitFor(() => expect(onRemove).toHaveBeenCalledOnce());
		expect(onSave).not.toHaveBeenCalled();
	});

	it('says a failed save and keeps the form open', async () => {
		await row({ onSave: vi.fn(async () => Promise.reject(new Error('E_LOCK_TIMEOUT'))) });
		await toggle().click();
		await page.getByRole('radio', { name: 'Retiring', exact: true }).click();
		await saveButton().click();
		await expect.element(page.getByText(FAILED)).toBeVisible();
		await expect.element(toggle()).toHaveAttribute('aria-expanded', 'true');
	});

	// A held key repeats about every 40 ms; each repeat that reached the form would act again once the last save
	// settled, and a save that lands hands focus to the toggle, so a repeat there would open the form again.
	const press = async (type: 'keyDown' | 'keyUp', autoRepeat = false) =>
		cdp().send('Input.dispatchKeyEvent', { type, autoRepeat, ...ENTER });
	async function hold(): Promise<void> {
		await press('keyDown');
		for (let i = 0; i < 15; i++) {
			await new Promise((resolve) => setTimeout(resolve, 40));
			await press('keyDown', true);
		}
		await press('keyUp');
	}
	async function pressOnce(): Promise<void> {
		await press('keyDown');
		await press('keyUp');
	}

	it.each([
		['Save', 'at once', 0],
		['Save', 'after a while', 100],
		['a choice', 'at once', 0],
		['a choice', 'after a while', 100]
	] as const)('saves once and stays closed for a held Enter on %s, saved %s', async (on, _, ms) => {
		const onSave = vi.fn(
			() => new Promise<string | null>((resolve) => setTimeout(() => resolve(null), ms))
		);
		await row({ onSave });
		await toggle().click();
		await page.getByRole('radio', { name: 'Retiring', exact: true }).click();
		const target =
			on === 'Save'
				? saveButton().element()
				: page.getByRole('radio', { name: 'Retiring', exact: true }).element();
		(target as HTMLElement).focus();
		await hold();
		await new Promise((resolve) => setTimeout(resolve, ms + 50));
		expect(onSave).toHaveBeenCalledOnce();
		await expect.element(toggle()).toHaveAttribute('aria-expanded', 'false');
		expect(document.activeElement).toBe(toggle().element());
		await pressOnce();
		await expect.element(toggle()).toHaveAttribute('aria-expanded', 'true');
	});

	it.each([
		['at once', 0],
		['after a while', 100]
	] as const)(
		'removes once and stays closed for a held Enter on Remove, removed %s',
		async (_, ms) => {
			const onRemove = vi.fn(
				() => new Promise<string | null>((resolve) => setTimeout(() => resolve(null), ms))
			);
			await row({ value: 'ets', onRemove });
			await toggle().click();
			(page.getByRole('button', { name: 'Remove answer' }).element() as HTMLElement).focus();
			await hold();
			await new Promise((resolve) => setTimeout(resolve, ms + 50));
			expect(onRemove).toHaveBeenCalledOnce();
			await expect.element(toggle()).toHaveAttribute('aria-expanded', 'false');
			expect(document.activeElement).toBe(toggle().element());
			await pressOnce();
			await expect.element(toggle()).toHaveAttribute('aria-expanded', 'true');
		}
	);

	// Another tab removes the answer while this form is open with focus on Remove: the button goes, the form stays.
	it('moves focus to the row when Remove disappears under it', async () => {
		const { rerender } = await row({ value: 'ets' });
		await toggle().click();
		(page.getByRole('button', { name: 'Remove answer' }).element() as HTMLElement).focus();
		await rerender({ value: undefined });
		// Read after a drawn frame: a browser can move focus off a removed element late.
		await new Promise((resolve) => requestAnimationFrame(resolve));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await expect
			.element(page.getByRole('button', { name: 'Remove answer' }))
			.not.toBeInTheDocument();
		await expect.element(toggle()).toHaveAttribute('aria-expanded', 'true');
		expect(document.activeElement).toBe(toggle().element());
	});

	// A failed save keeps the form open, so the rest of the hold lands on the form again once the save settles.
	it.each([
		['Save', 'at once', 0],
		['Save', 'after a while', 100],
		['a choice', 'at once', 0],
		['a choice', 'after a while', 100]
	] as const)('saves once for a held Enter on %s when the save fails %s', async (on, _, ms) => {
		const onSave = vi.fn(
			() => new Promise<string | null>((resolve) => setTimeout(() => resolve(FAILED), ms))
		);
		await row({ onSave });
		await toggle().click();
		await page.getByRole('radio', { name: 'Retiring', exact: true }).click();
		const target =
			on === 'Save'
				? saveButton().element()
				: page.getByRole('radio', { name: 'Retiring', exact: true }).element();
		(target as HTMLElement).focus();
		await hold();
		await expect.element(page.getByText(FAILED)).toBeVisible();
		await new Promise((resolve) => setTimeout(resolve, ms + 50));
		expect(onSave).toHaveBeenCalledOnce();
		await pressOnce();
		await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
	});
});
