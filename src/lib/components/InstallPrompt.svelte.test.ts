import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import InstallPrompt from './InstallPrompt.svelte';

describe('InstallPrompt', () => {
	it('shows an Install button when the browser can prompt, and fires onInstall', () => {
		const onInstall = vi.fn();
		const { container } = render(InstallPrompt, { props: { canPrompt: true, onInstall } });
		const btn = container.querySelector<HTMLButtonElement>('.install-action');
		expect(btn?.textContent?.trim()).toBe('Install');
		expect(container.querySelector('.install-steps')).toBeNull();
		btn?.click();
		expect(onInstall).toHaveBeenCalledTimes(1);
	});

	it('shows the Add-to-Home-Screen steps directly when it cannot prompt (iOS)', () => {
		const { container } = render(InstallPrompt, {
			props: { canPrompt: false, onInstall: () => {} }
		});
		const steps = container.querySelectorAll('.install-steps li');
		expect(steps.length).toBe(3);
		expect(container.textContent).toContain('Add to Home Screen');
		expect(container.querySelector('.install-action')).toBeNull();
	});

	it('collapses the steps behind "Show me how" when collapsibleSteps is set (the Home card)', () => {
		const { container } = render(InstallPrompt, {
			props: { canPrompt: false, onInstall: () => {}, collapsibleSteps: true }
		});
		const toggle = container.querySelector<HTMLButtonElement>('.install-action');
		expect(toggle?.textContent?.trim()).toBe('Show me how');
		expect(container.querySelector('.install-steps')).toBeNull();

		toggle?.click();
		flushSync();
		expect(container.querySelectorAll('.install-steps li').length).toBe(3);
	});
});
