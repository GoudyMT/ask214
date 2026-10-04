import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ComponentProps } from 'svelte';
import SettingsDateRow from './SettingsDateRow.svelte';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

const row = (over: Partial<ComponentProps<typeof SettingsDateRow>> = {}) =>
	render(SettingsDateRow, {
		props: {
			id: 'skillbridge-start',
			label: 'SkillBridge start',
			value: null,
			hint: 'A hint.',
			onSave: vi.fn(async () => null),
			...over
		}
	});

describe('SettingsDateRow', () => {
	it('shows Not set, or the date as Mon D, YYYY', async () => {
		row();
		await expect.element(page.getByText('Not set')).toBeVisible();
		row({ id: 'terminal-leave-start', label: 'Terminal leave start', value: '2027-04-01' });
		await expect.element(page.getByText('Apr 1, 2027')).toBeVisible();
	});

	it('saves the typed date, closes, and returns focus to the row', async () => {
		const onSave = vi.fn(async () => null);
		row({ onSave });
		const toggle = page.getByRole('button', { name: /skillbridge start/i });
		await toggle.click();
		await page.getByLabelText('SkillBridge start').fill('2026-11-01');
		await page.getByRole('button', { name: /^save$/i }).click();
		expect(onSave).toHaveBeenCalledWith('2026-11-01');
		await expect.element(page.getByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
		await expect.element(toggle).toHaveFocus();
	});

	it('shows the message a refused save returns, and stays open', async () => {
		row({ onSave: vi.fn(async () => 'This date needs to be before your separation date.') });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		await page.getByRole('button', { name: /^save$/i }).click();
		await expect
			.element(page.getByText('This date needs to be before your separation date.'))
			.toBeVisible();
		await expect.element(page.getByRole('button', { name: /^save$/i })).toBeVisible();
	});

	it('says so when a save fails, rather than failing silently', async () => {
		row({ onSave: vi.fn(async () => Promise.reject(new Error('E_LOCK_TIMEOUT'))) });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		await page.getByRole('button', { name: /^save$/i }).click();
		await expect
			.element(page.getByText('Could not update right now - please try again.'))
			.toBeVisible();
	});

	it('offers Remove only on a removable row with a date', async () => {
		const onRemove = vi.fn(async () => null);
		row({ value: '2026-11-01', onRemove });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		await page.getByRole('button', { name: /^remove$/i }).click();
		expect(onRemove).toHaveBeenCalledOnce();
	});

	it('draws no Remove without a date or without onRemove', async () => {
		row({ onRemove: vi.fn(async () => null) });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		expect(page.getByRole('button', { name: /^remove$/i }).query()).toBeNull();
	});

	it('gives every row its own ids', async () => {
		row();
		row({ id: 'terminal-leave-start', label: 'Terminal leave start' });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		await page.getByRole('button', { name: /terminal leave start/i }).click();
		const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).not.toContain('eaos-input');
	});

	it('says nothing about what the user qualifies for', async () => {
		const { container } = row({ value: '2026-11-01', onRemove: vi.fn(async () => null) });
		for (const line of textOf(container).split('\n')) expect(makesPersonalClaim(line)).toBe(false);
	});
});
