import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ComponentProps } from 'svelte';
import SettingsDateRow from './SettingsDateRow.svelte';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

const row = async (over: Partial<ComponentProps<typeof SettingsDateRow>> = {}) =>
	await render(SettingsDateRow, {
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
		await row();
		await expect.element(page.getByText('Not set')).toBeVisible();
		await row({ id: 'terminal-leave-start', label: 'Terminal leave start', value: '2027-04-01' });
		await expect.element(page.getByText('Apr 1, 2027')).toBeVisible();
	});

	it('saves the typed date, closes, and returns focus to the row', async () => {
		const onSave = vi.fn(async () => null);
		await row({ onSave });
		const toggle = page.getByRole('button', { name: /skillbridge start/i });
		await toggle.click();
		await page.getByLabelText('SkillBridge start').fill('2026-11-01');
		await page.getByRole('button', { name: /^save$/i }).click();
		expect(onSave).toHaveBeenCalledWith('2026-11-01');
		await expect.element(page.getByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
		await expect.element(toggle).toHaveFocus();
	});

	it('shows the message a refused save returns, and stays open', async () => {
		await row({ onSave: vi.fn(async () => 'This date needs to be before your separation date.') });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		await page.getByRole('button', { name: /^save$/i }).click();
		await expect
			.element(page.getByText('This date needs to be before your separation date.'))
			.toBeVisible();
		await expect.element(page.getByRole('button', { name: /^save$/i })).toBeVisible();
	});

	it('says so when a save fails, rather than failing silently', async () => {
		await row({ onSave: vi.fn(async () => Promise.reject(new Error('E_LOCK_TIMEOUT'))) });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		await page.getByRole('button', { name: /^save$/i }).click();
		await expect
			.element(page.getByText('Could not update right now - please try again.'))
			.toBeVisible();
	});

	it('takes a new date after a refused save', async () => {
		const onSave = vi
			.fn<(draft: string) => Promise<string | null>>()
			.mockResolvedValueOnce('This date needs to be before your separation date.')
			.mockResolvedValueOnce(null);
		await row({ onSave });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		await page.getByLabelText('SkillBridge start').fill('2027-06-01');
		await page.getByRole('button', { name: /^save$/i }).click();
		await expect
			.element(page.getByText('This date needs to be before your separation date.'))
			.toBeVisible();
		await page.getByLabelText('SkillBridge start').fill('2026-11-01');
		const save = page.getByRole('button', { name: /^save$/i });
		await expect.element(save).toBeEnabled();
		await save.click();
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(onSave).toHaveBeenLastCalledWith('2026-11-01');
	});

	it('opens on the stored date and saves it as it stands', async () => {
		const onSave = vi.fn(async () => null);
		await row({ value: '2026-11-01', onSave });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		await expect.element(page.getByLabelText('SkillBridge start')).toHaveValue('2026-11-01');
		await page.getByRole('button', { name: /^save$/i }).click();
		expect(onSave).toHaveBeenCalledWith('2026-11-01');
	});

	it('closes on a second tap of the row', async () => {
		const { container } = await row();
		const toggle = page.getByRole('button', { name: /skillbridge start/i });
		await toggle.click();
		await toggle.click();
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
		expect(container.querySelector('form')).toBeNull();
	});

	// The second press is a DOM click: a locator waits for an enabled button, so it would time out, not count.
	it('saves once while a save is still running', async () => {
		const onSave = vi.fn(() => new Promise<string | null>(() => {}));
		const { container } = await row({ onSave });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		await page.getByLabelText('SkillBridge start').fill('2026-11-01');
		await page.getByRole('button', { name: /^save$/i }).click();
		await expect.element(page.getByRole('button', { name: /^save$/i })).toBeDisabled();
		(container.querySelector('.settings-save') as HTMLButtonElement).click();
		expect(onSave).toHaveBeenCalledOnce();
	});

	it('offers Remove only on a removable row with a date', async () => {
		const onRemove = vi.fn(async () => null);
		await row({ value: '2026-11-01', onRemove });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		await page.getByRole('button', { name: /^remove$/i }).click();
		expect(onRemove).toHaveBeenCalledOnce();
	});

	it('draws no Remove without a date or without onRemove', async () => {
		await row({ onRemove: vi.fn(async () => null) });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		expect(page.getByRole('button', { name: /^remove$/i }).query()).toBeNull();
	});

	it('gives every row its own ids', async () => {
		await row();
		await row({ id: 'terminal-leave-start', label: 'Terminal leave start' });
		await page.getByRole('button', { name: /skillbridge start/i }).click();
		await page.getByRole('button', { name: /terminal leave start/i }).click();
		const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).not.toContain('eaos-input');
	});

	it('says nothing about what the user qualifies for', async () => {
		const { container } = await row({ value: '2026-11-01', onRemove: vi.fn(async () => null) });
		for (const line of textOf(container).split('\n')) expect(makesPersonalClaim(line)).toBe(false);
	});
});

// Component tests run without app.css, so the cases set the tokens the row uses and give it the width it gets in
// the Settings section on a 320 px phone (measured on the build: a 272 px section less its padding and border).
// The tokens and the frame's size are put back after each case.
describe('SettingsDateRow (layout by width)', () => {
	const TOKENS: Record<string, string> = {
		'--space-xs': '4px',
		'--space-s': '8px',
		'--space-m': '16px',
		'--space-l': '24px',
		'--font-size-s': '14px'
	};
	const PHONE_ROW_WIDTH = '222px';
	let size = { width: 0, height: 0 };
	beforeEach(() => {
		size = { width: window.innerWidth, height: window.innerHeight };
		for (const [name, value] of Object.entries(TOKENS)) {
			document.documentElement.style.setProperty(name, value);
		}
	});
	afterEach(async () => {
		for (const name of Object.keys(TOKENS)) document.documentElement.style.removeProperty(name);
		await page.viewport(size.width, size.height);
	});

	it('on a 320 px phone the date reads on one line beside a label that wraps', async () => {
		await page.viewport(320, 800);
		const { container } = await row({
			id: 'eaos',
			label: 'Separation date (EAOS)',
			value: '2027-04-30'
		});
		container.style.width = PHONE_ROW_WIDTH;
		const summary = container.querySelector('.settings-disclosure__summary') as HTMLElement;
		const lines = document.createRange();
		lines.selectNodeContents(summary);
		expect(summary.textContent).toBe('Apr 30, 2027');
		expect(lines.getClientRects()).toHaveLength(1);
	});

	it('on a 320 px phone an open row keeps every button inside it, each row a 44 px target', async () => {
		await page.viewport(320, 800);
		const { container } = await row({ value: '2026-11-01', onRemove: vi.fn(async () => null) });
		container.style.width = PHONE_ROW_WIDTH;
		const toggle = container.querySelector('.settings-disclosure__toggle') as HTMLElement;
		toggle.click();
		await expect.element(page.getByRole('button', { name: /^remove$/i })).toBeVisible();
		const frame = container.getBoundingClientRect();
		for (const button of container.querySelectorAll('.settings-edit__actions button')) {
			expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(frame.right);
		}
		expect(toggle.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
	});
});
