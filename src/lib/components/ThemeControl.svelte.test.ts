import { render } from 'vitest-browser-svelte';
import { describe, it, expect, beforeEach } from 'vitest';
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
	it('renders System / Light / Dark as a labeled button group', () => {
		const { container } = render(ThemeControl);
		const group = container.querySelector('[role="group"]');
		expect(group?.getAttribute('aria-label')).toBe('Theme');
		expect(buttonByText(container, 'System')).toBeDefined();
		expect(buttonByText(container, 'Light')).toBeDefined();
		expect(buttonByText(container, 'Dark')).toBeDefined();
	});

	it('marks the persisted choice active (System by default)', () => {
		const { container } = render(ThemeControl);
		expect(buttonByText(container, 'System')?.getAttribute('aria-pressed')).toBe('true');
		expect(buttonByText(container, 'Dark')?.getAttribute('aria-pressed')).toBe('false');
	});

	it('reflects a persisted explicit choice on mount', () => {
		localStorage.setItem('mtc:theme', 'dark');
		const { container } = render(ThemeControl);
		expect(buttonByText(container, 'Dark')?.getAttribute('aria-pressed')).toBe('true');
		expect(buttonByText(container, 'System')?.getAttribute('aria-pressed')).toBe('false');
	});

	it('clicking Dark applies data-theme=dark, persists it, and moves the active state', () => {
		const { container } = render(ThemeControl);
		buttonByText(container, 'Dark')?.click();
		flushSync();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(localStorage.getItem('mtc:theme')).toBe('dark');
		expect(buttonByText(container, 'Dark')?.getAttribute('aria-pressed')).toBe('true');
		expect(buttonByText(container, 'System')?.getAttribute('aria-pressed')).toBe('false');
	});

	it('clicking System removes the data-theme attribute (OS-driven) and persists system', () => {
		localStorage.setItem('mtc:theme', 'dark');
		document.documentElement.setAttribute('data-theme', 'dark');
		const { container } = render(ThemeControl);
		buttonByText(container, 'System')?.click();
		flushSync();
		expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
		expect(localStorage.getItem('mtc:theme')).toBe('system');
		expect(buttonByText(container, 'System')?.getAttribute('aria-pressed')).toBe('true');
	});
});
