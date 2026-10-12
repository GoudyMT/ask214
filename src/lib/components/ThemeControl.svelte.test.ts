import { render } from 'vitest-browser-svelte';
import { describe, it, expect, beforeEach } from 'vitest';
import { cdp } from 'vitest/browser';
import { flushSync } from 'svelte';
import ThemeControl from './ThemeControl.svelte';

// The control writes real theme state (data-theme on <html> + localStorage['mtc:theme']), so reset
// both before each test to keep them isolated. Testing against the real theme module (not a mock)
// proves the control is wired to setTheme end-to-end.
beforeEach(() => {
	localStorage.clear();
	document.documentElement.removeAttribute('data-theme');
});

function buttonByText(container: Element, text: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

describe('ThemeControl', () => {
	it('renders System / Light / Dark as a labeled button group', async () => {
		const { container } = await render(ThemeControl);
		const group = container.querySelector('[role="group"]');
		expect(group?.getAttribute('aria-label')).toBe('Theme');
		expect(buttonByText(container, 'System')).toBeDefined();
		expect(buttonByText(container, 'Light')).toBeDefined();
		expect(buttonByText(container, 'Dark')).toBeDefined();
	});

	it('marks the persisted choice active (System by default)', async () => {
		const { container } = await render(ThemeControl);
		expect(buttonByText(container, 'System')?.getAttribute('aria-pressed')).toBe('true');
		expect(buttonByText(container, 'Dark')?.getAttribute('aria-pressed')).toBe('false');
	});

	it('reflects a persisted explicit choice on mount', async () => {
		localStorage.setItem('mtc:theme', 'dark');
		const { container } = await render(ThemeControl);
		expect(buttonByText(container, 'Dark')?.getAttribute('aria-pressed')).toBe('true');
		expect(buttonByText(container, 'System')?.getAttribute('aria-pressed')).toBe('false');
	});

	it('clicking Dark applies data-theme=dark, persists it, and moves the active state', async () => {
		const { container } = await render(ThemeControl);
		buttonByText(container, 'Dark')?.click();
		flushSync();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(localStorage.getItem('mtc:theme')).toBe('dark');
		expect(buttonByText(container, 'Dark')?.getAttribute('aria-pressed')).toBe('true');
		expect(buttonByText(container, 'System')?.getAttribute('aria-pressed')).toBe('false');
	});

	// Forced colors drop the accent fill that marks the chosen theme, so there a ring in the system highlight colour
	// marks it; the normal look has none.
	it('marks the chosen theme by a 3 px ring in forced colors only', async () => {
		localStorage.setItem('mtc:theme', 'light');
		const { container } = await render(ThemeControl);
		const buttons = [...container.querySelectorAll('button')];
		const rings = () =>
			buttons.map((b) =>
				getComputedStyle(b).borderTopStyle === 'none' ? 'none' : getComputedStyle(b).borderTopWidth
			);
		const sizes = () =>
			buttons.map((b) => [b.getBoundingClientRect().width, b.getBoundingClientRect().height]);
		expect(rings()).toEqual(['none', 'none', 'none']);
		const before = sizes();
		const session = cdp();
		await session.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'forced-colors', value: 'active' }]
		});
		try {
			await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(true);
			expect(rings()).toEqual(['none', '3px', 'none']);
			// The ring is the system highlight colour, and the chosen button keeps its size.
			const probe = document.createElement('span');
			probe.style.color = 'Highlight';
			document.body.append(probe);
			expect(getComputedStyle(buttons[1]!).borderTopColor).toBe(getComputedStyle(probe).color);
			probe.remove();
			expect(sizes()).toEqual(before);
			// The mark leaves the outline free, so the chosen pill shows the same focus ring as the others.
			const focusRing = (b: HTMLButtonElement) => {
				b.focus();
				expect(b.matches(':focus-visible')).toBe(true);
				const s = getComputedStyle(b);
				return [s.outlineStyle, s.outlineWidth, s.outlineOffset, s.outlineColor];
			};
			expect(focusRing(buttons[1]!)).toEqual(focusRing(buttons[0]!));
		} finally {
			await session.send('Emulation.setEmulatedMedia', {
				features: [{ name: 'forced-colors', value: 'none' }]
			});
		}
		await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(false);
		expect(rings()).toEqual(['none', 'none', 'none']);
	});

	it('clicking System removes the data-theme attribute (OS-driven) and persists system', async () => {
		localStorage.setItem('mtc:theme', 'dark');
		document.documentElement.setAttribute('data-theme', 'dark');
		const { container } = await render(ThemeControl);
		buttonByText(container, 'System')?.click();
		flushSync();
		expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
		expect(localStorage.getItem('mtc:theme')).toBe('system');
		expect(buttonByText(container, 'System')?.getAttribute('aria-pressed')).toBe('true');
	});
});
