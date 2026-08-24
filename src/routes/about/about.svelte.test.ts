import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import AboutPage from './+page.svelte';

// Integration: the real generated SOURCES_INDEX flows through the page. Asserts known agency + TAP
// titles render (so the whole registry -> generator -> artifact -> component chain is wired), plus the
// single TAP library link and the honest lede.
describe('About page sources index', () => {
	it('renders a known agency source and its official link', () => {
		const { container } = render(AboutPage);
		expect(container.textContent ?? '').toContain('VA - Your Intent to File a VA Claim');
		const link = [...container.querySelectorAll('a')].find(
			(a) =>
				a.getAttribute('href') === 'https://www.va.gov/resources/your-intent-to-file-a-va-claim/'
		);
		expect(link?.getAttribute('target')).toBe('_blank');
	});

	it('renders a known TAP guide title behind the one shared library link', () => {
		const { container } = render(AboutPage);
		expect(container.textContent ?? '').toContain('TAP - Financial Planning for Transition');
		const tapLinks = [...container.querySelectorAll('a')].filter(
			(a) => a.getAttribute('href') === 'https://www.tapevents.mil/resources/documents'
		);
		expect(tapLinks).toHaveLength(1);
	});

	it('keeps the honest sources lede', () => {
		const { container } = render(AboutPage);
		const text = container.textContent ?? '';
		expect(text).toMatch(/public US Government work/i);
		expect(text).toMatch(/17 USC/i);
	});
});
