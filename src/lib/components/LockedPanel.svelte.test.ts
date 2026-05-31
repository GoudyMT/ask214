import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import LockedPanel from './LockedPanel.svelte';

describe('LockedPanel', () => {
	it('renders the locked heading and an Unlock button', () => {
		const { container } = render(LockedPanel, { props: { onunlock: () => {} } });
		expect(container.querySelector('h2')?.textContent).toBe('Your data is locked');
		expect(container.querySelector('button')?.textContent?.trim()).toBe('Unlock');
	});

	it('calls onunlock when the Unlock button is clicked', () => {
		const onunlock = vi.fn();
		const { container } = render(LockedPanel, { props: { onunlock } });
		container.querySelector('button')?.click();
		expect(onunlock).toHaveBeenCalledTimes(1);
	});

	it('disables the button and shows progress while busy', () => {
		const { container } = render(LockedPanel, { props: { onunlock: () => {}, busy: true } });
		const btn = container.querySelector('button');
		expect(btn?.disabled).toBe(true);
		expect(btn?.textContent?.trim()).toBe('Unlocking...');
	});
});
