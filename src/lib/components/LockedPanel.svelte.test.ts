import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import LockedPanel from './LockedPanel.svelte';

describe('LockedPanel', () => {
	it('renders the locked heading and an Unlock button', async () => {
		const { container } = await render(LockedPanel, { props: { onunlock: () => {} } });
		expect(container.querySelector('h2')?.textContent).toBe('Your data is locked');
		expect(container.querySelector('button')?.textContent?.trim()).toBe('Unlock');
	});

	it('calls onunlock when the Unlock button is clicked', async () => {
		const onunlock = vi.fn();
		const { container } = await render(LockedPanel, { props: { onunlock } });
		container.querySelector('button')?.click();
		expect(onunlock).toHaveBeenCalledTimes(1);
	});

	// A disabled button that holds focus drops it, so busy ignores a press instead.
	it('shows progress while busy and ignores a press', async () => {
		const onunlock = vi.fn();
		const { container } = await render(LockedPanel, { props: { onunlock, busy: true } });
		const btn = container.querySelector('button');
		expect(btn?.disabled).toBe(false);
		expect(btn?.textContent?.trim()).toBe('Unlocking...');
		btn?.click();
		expect(onunlock).toHaveBeenCalledTimes(0);
	});

	// Only a held Enter is held back: a held Tab still moves on, and arrow keys still scroll.
	it('holds back a repeated Enter and no other repeated key', async () => {
		const { container } = await render(LockedPanel, { props: { onunlock: vi.fn() } });
		const btn = container.querySelector('button')!;
		const held = (key: string) => {
			const e = new KeyboardEvent('keydown', {
				key,
				repeat: true,
				cancelable: true,
				bubbles: true
			});
			btn.dispatchEvent(e);
			return e.defaultPrevented;
		};
		expect([held('Enter'), held('Tab'), held('ArrowDown')]).toEqual([true, false, false]);
	});

	// The button keeps focus while busy, and its label says it is working: a dim would fade its focus ring (below 3:1) or
	// its label (below 4.5:1), so it keeps its normal look.
	it('keeps its normal look while busy', async () => {
		// Component tests run without app.css; the colour tokens are set here as the app defines them, and removed.
		const root = document.documentElement.style;
		root.setProperty('--color-accent', '#1a66c2');
		root.setProperty('--color-bg', '#ffffff');
		try {
			const idle = await render(LockedPanel, { props: { onunlock: vi.fn() } });
			const idleFill = getComputedStyle(idle.container.querySelector('button')!).backgroundColor;
			idle.unmount();
			const { container } = await render(LockedPanel, { props: { onunlock: vi.fn(), busy: true } });
			const busy = getComputedStyle(container.querySelector('button')!);
			expect(busy.opacity).toBe('1');
			expect(busy.backgroundColor).toBe(idleFill);
		} finally {
			root.removeProperty('--color-accent');
			root.removeProperty('--color-bg');
		}
	});

	it('says why an unlock failed, as an alert after the button', async () => {
		const LINE = 'Could not unlock right now - please try again.';
		const { container } = await render(LockedPanel, { props: { onunlock: () => {}, error: LINE } });
		const alert = container.querySelector('[role="alert"]');
		expect(alert?.textContent?.trim()).toBe(LINE);
		const btn = container.querySelector('button');
		expect(
			btn && alert && btn.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('shows no alert without an error', async () => {
		const { container } = await render(LockedPanel, { props: { onunlock: () => {} } });
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});
});
