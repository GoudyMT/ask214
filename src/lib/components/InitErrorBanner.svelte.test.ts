import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import InitErrorBanner from './InitErrorBanner.svelte';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

describe('InitErrorBanner', () => {
	it('says the saved information could not be opened, and offers a reload', async () => {
		const onReload = vi.fn();
		render(InitErrorBanner, { props: { onReload } });
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent(
				"The app couldn't open the information saved on this device. Reload to try again."
			);
		await page.getByRole('button', { name: 'Reload' }).click();
		expect(onReload).toHaveBeenCalledOnce();
	});

	it('makes Reload a 44 px target', () => {
		const { container } = render(InitErrorBanner, { props: { onReload: vi.fn() } });
		const reload = container.querySelector('.init-banner__reload') as HTMLElement;
		expect(reload.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
	});

	it('says nothing personal', () => {
		const { container } = render(InitErrorBanner, { props: { onReload: vi.fn() } });
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);
	});
});
