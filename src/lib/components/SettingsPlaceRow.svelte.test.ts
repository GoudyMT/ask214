import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ComponentProps } from 'svelte';
import SettingsPlaceRow from './SettingsPlaceRow.svelte';
import { scrubSecureInputs } from '../profile/lifecycle';

const row = async (over: Partial<ComponentProps<typeof SettingsPlaceRow>> = {}) =>
	await render(SettingsPlaceRow, {
		props: {
			id: 'destination',
			label: 'Where you plan to live',
			value: null,
			hint: 'A hint.',
			onSave: vi.fn(async () => null),
			onRemove: vi.fn(async () => null),
			...over
		}
	});

const toggle = () => page.getByRole('button', { name: /where you plan to live/i });
const field = () => page.getByLabelText('Where you plan to live');

describe('SettingsPlaceRow', () => {
	it('saves the typed text, closes, and returns focus to the row', async () => {
		const onSave = vi.fn(async () => null);
		await row({ onSave });
		await toggle().click();
		await field().fill('21046');
		await page.getByRole('button', { name: /^save$/i }).click();

		expect(onSave).toHaveBeenCalledWith('21046');
		await expect.element(page.getByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
		await expect.element(toggle()).toHaveFocus();
	});

	it('opens on the stored place, and offers Remove only when there is one', async () => {
		await row({ value: 'Maryland' });
		await toggle().click();
		await expect.element(field()).toHaveValue('Maryland');
		await expect.element(page.getByRole('button', { name: /^remove$/i })).toBeVisible();
	});

	it('draws no Remove with no stored place', async () => {
		await row();
		await toggle().click();
		await expect.element(field()).toBeVisible();
		expect(page.getByRole('button', { name: /^remove$/i }).query()).toBeNull();
	});

	it('shows a refusal against the field, and clears it as soon as the person types again', async () => {
		const REFUSED = 'Enter a 5-digit ZIP code or a state name.';
		await row({ onSave: vi.fn(async () => REFUSED) });
		await toggle().click();
		await field().fill('12');
		await page.getByRole('button', { name: /^save$/i }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(REFUSED);
		await expect.element(field()).toHaveAttribute('aria-invalid', 'true');

		await field().fill('21');
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	});

	// A relock clears every typed profile value from the page; a place typed and left unsaved is one of them.
	it('is emptied by a relock while the person is typing', async () => {
		await row();
		await toggle().click();
		await field().fill('Maryland');
		scrubSecureInputs();

		expect((field().element() as HTMLInputElement).value).toBe('');
	});
});
