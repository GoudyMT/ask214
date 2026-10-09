import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import InitErrorBanner from './InitErrorBanner.svelte';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

describe('InitErrorBanner', () => {
	it('says the saved information could not be opened, and offers a reload', async () => {
		const onReload = vi.fn();
		await render(InitErrorBanner, { props: { onReload } });
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent(
				"The app couldn't open the information saved on this device. Reload to try again."
			);
		await page.getByRole('button', { name: 'Reload' }).click();
		expect(onReload).toHaveBeenCalledOnce();
	});

	it('makes Reload a 44 px target', async () => {
		const { container } = await render(InitErrorBanner, { props: { onReload: vi.fn() } });
		const reload = container.querySelector('.init-banner__reload') as HTMLElement;
		expect(reload.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
	});

	it('says nothing personal', async () => {
		const { container } = await render(InitErrorBanner, { props: { onReload: vi.fn() } });
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);
	});

	// Damaged saved data: a reload reads the same bytes and fails the same way, so the banner points to the erase in
	// Settings instead of offering Reload.
	it('points damaged saved data to the erase in Settings, with no Reload', async () => {
		await render(InitErrorBanner, { props: { damaged: true } });
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent(
				"The information saved on this device can't be read. You can erase it in Settings and start again."
			);
		await expect
			.element(page.getByRole('link', { name: 'Settings' }))
			.toHaveAttribute('href', '/settings');
		expect(page.getByRole('button', { name: 'Reload' }).elements()).toHaveLength(0);
	});

	it('says nothing personal about damaged saved data', async () => {
		const { container } = await render(InitErrorBanner, { props: { damaged: true } });
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);
	});
});
