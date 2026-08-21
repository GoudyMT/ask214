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

	it('shows the Add-to-Home-Screen steps directly when it cannot prompt (iOS / Settings)', () => {
		const { container } = render(InstallPrompt, {
			props: { canPrompt: false, onInstall: () => {} }
		});
		const steps = container.querySelector<HTMLOListElement>('.install-steps');
		expect(steps?.querySelectorAll('li').length).toBe(3);
		expect(steps?.hidden).toBe(false);
		expect(container.textContent).toContain('Add to Home Screen');
		expect(container.querySelector('.install-action')).toBeNull();
	});

	it('collapses the steps behind an accessible "Show me how" disclosure (the Home card)', () => {
		const { container } = render(InstallPrompt, {
			props: { canPrompt: false, onInstall: () => {}, collapsibleSteps: true }
		});
		const toggle = container.querySelector<HTMLButtonElement>('.install-action');
		expect(toggle?.textContent?.trim()).toBe('Show me how');
		// A proper disclosure: the trigger persists (focus is never dropped), announces its state, and
		// controls the steps by id; the steps stay in the DOM but hidden until opened.
		expect(toggle?.getAttribute('aria-expanded')).toBe('false');
		expect(toggle?.getAttribute('aria-controls')).toBe('install-steps');
		expect(container.querySelector<HTMLOListElement>('.install-steps')?.id).toBe('install-steps');
		expect(container.querySelector<HTMLOListElement>('.install-steps')?.hidden).toBe(true);

		toggle?.click();
		flushSync();
		expect(toggle?.getAttribute('aria-expanded')).toBe('true');
		expect(container.querySelector<HTMLOListElement>('.install-steps')?.hidden).toBe(false);
	});
});
