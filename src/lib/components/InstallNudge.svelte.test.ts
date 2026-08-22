import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import InstallNudge from './InstallNudge.svelte';

const base = { canPrompt: false, onInstall: () => {}, ondismiss: () => {} };

describe('InstallNudge', () => {
	it('renders as a dismissible card with the durability framing', () => {
		const { container } = render(InstallNudge, { props: base });
		expect(container.querySelector('.install-nudge')).not.toBeNull();
		expect(container.textContent).toContain('less likely');
		expect(container.querySelector('.install-nudge__dismiss')).not.toBeNull();
	});

	it('offers a one-tap Install when the browser can prompt', () => {
		const { container } = render(InstallNudge, { props: { ...base, canPrompt: true } });
		expect(container.querySelector('h2')?.textContent).toContain('Install');
		expect(container.querySelector('.install-action')?.textContent?.trim()).toBe('Install');
	});

	it('offers the collapsed "Show me how" path when it cannot prompt (iOS)', () => {
		const { container } = render(InstallNudge, { props: { ...base, canPrompt: false } });
		expect(container.querySelector('.install-action')?.textContent?.trim()).toBe('Show me how');
	});

	it('fires ondismiss when the dismiss control is clicked', () => {
		const ondismiss = vi.fn();
		const { container } = render(InstallNudge, { props: { ...base, ondismiss } });
		container.querySelector<HTMLButtonElement>('.install-nudge__dismiss')?.click();
		expect(ondismiss).toHaveBeenCalledTimes(1);
	});
});
