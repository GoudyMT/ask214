import { render } from 'vitest-browser-svelte';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import CompareTray from './CompareTray.svelte';

afterEach(() => {
	document.documentElement.style.removeProperty('--bottom-bar-height');
});

describe('CompareTray', () => {
	it('says how many of the three are picked', async () => {
		const { container } = await render(CompareTray, { props: { count: 2, oncompare: vi.fn() } });
		expect(container.textContent).toContain('2 of 3 picked');
	});

	it('opens the comparison from its Compare button', async () => {
		const oncompare = vi.fn();
		const { container } = await render(CompareTray, { props: { count: 2, oncompare } });
		const button = container.querySelector('button')!;
		expect(button.textContent?.trim()).toBe('Compare');
		expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
		button.click();
		expect(oncompare).toHaveBeenCalledOnce();
	});

	it('rests on top of the bottom bar, not under it', async () => {
		document.documentElement.style.setProperty('--bottom-bar-height', '61px');
		const { container } = await render(CompareTray, { props: { count: 1, oncompare: vi.fn() } });
		const tray = container.firstElementChild as HTMLElement;
		expect(getComputedStyle(tray).position).toBe('fixed');
		expect(tray.getBoundingClientRect().bottom).toBe(window.innerHeight - 61);
	});

	it('stays in the page column on a wide screen, centred', async () => {
		const size = { width: window.innerWidth, height: window.innerHeight };
		await page.viewport(1200, 800);
		try {
			const { container } = await render(CompareTray, { props: { count: 1, oncompare: vi.fn() } });
			const box = (container.firstElementChild as HTMLElement).getBoundingClientRect();
			expect(box.width).toBe(720);
			expect(box.left).toBe(240);
		} finally {
			await page.viewport(size.width, size.height);
		}
	});
});
