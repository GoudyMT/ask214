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

	// The page already keeps a focused control clear of the bottom bar; the tray stands above the bar, so it must add its
	// own height to that room or Tab lands a control behind it (WCAG 2.4.11).
	describe('on a 320 px phone with a long page behind it', () => {
		const size = { width: 0, height: 0 };
		const undo: (() => void)[] = [];
		afterEach(async () => {
			for (const fn of undo.splice(0)) fn();
			window.scrollTo(0, 0);
			await page.viewport(size.width, size.height);
		});

		async function longPage() {
			size.width = window.innerWidth;
			size.height = window.innerHeight;
			await page.viewport(320, 568);
			// What the root layout supplies: the bar's height, and the scroll padding that keeps a focus above it.
			document.documentElement.style.setProperty('--bottom-bar-height', '57px');
			const rule = document.createElement('style');
			rule.textContent =
				'html{scroll-padding-bottom:calc(var(--bottom-bar-height) + env(safe-area-inset-bottom))}';
			const rows = document.createElement('div');
			const buttons = Array.from({ length: 30 }, (_, n) => {
				const b = document.createElement('button');
				b.textContent = `Row ${n}`;
				b.style.display = 'block';
				b.style.height = '44px';
				b.style.marginBottom = '12px';
				return b;
			});
			rows.append(...buttons);
			document.head.append(rule);
			document.body.prepend(rows);
			undo.push(
				() => rule.remove(),
				() => rows.remove()
			);
			return buttons;
		}

		it('keeps a control that takes focus above the tray', async () => {
			const buttons = await longPage();
			const { container } = await render(CompareTray, { props: { count: 2, oncompare: vi.fn() } });
			const tray = container.firstElementChild as HTMLElement;
			const target = buttons[15]!;
			// Already inside the window, as a Tab stop is, but down where the tray covers it.
			window.scrollTo(0, window.scrollY + target.getBoundingClientRect().top - 470);
			await vi.waitFor(() => expect(target.getBoundingClientRect().top).toBe(470));

			target.focus();

			await vi.waitFor(() =>
				expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(
					tray.getBoundingClientRect().top
				)
			);
		});

		it('gives the page its own scroll room back when the tray goes', async () => {
			await longPage();
			const { unmount } = await render(CompareTray, { props: { count: 2, oncompare: vi.fn() } });
			expect(document.documentElement.style.scrollPaddingBottom).not.toBe('');

			unmount();

			expect(document.documentElement.style.scrollPaddingBottom).toBe('');
		});
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
