import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import AppUpdated from './AppUpdated.svelte';

describe('AppUpdated', () => {
	it('tells the user another tab updated the app and offers a reload', async () => {
		const { container } = await render(AppUpdated, { props: { onReload: () => {} } });
		expect(container.textContent).toContain('updated in another tab');
		const button = container.querySelector('button');
		expect(button?.textContent).toContain('Reload');
	});

	it('calls onReload when the reload button is clicked', async () => {
		const onReload = vi.fn();
		const { container } = await render(AppUpdated, { props: { onReload } });
		(container.querySelector('button') as HTMLButtonElement | null)?.click();
		expect(onReload).toHaveBeenCalledOnce();
	});
});
