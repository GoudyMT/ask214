import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import AboutPage from './+page.svelte';

// Integration: the real generated SOURCES_INDEX flows through the page. Asserts known agency + TAP
// titles render (so the whole registry -> generator -> artifact -> component chain is wired), plus the
// single TAP library link and the honest lede.
describe('About page sources index', () => {
	it('renders a known agency source and its official link', async () => {
		const { container } = await render(AboutPage);
		expect(container.textContent ?? '').toContain('VA - Your Intent to File a VA Claim');
		const link = [...container.querySelectorAll('a')].find(
			(a) =>
				a.getAttribute('href') === 'https://www.va.gov/resources/your-intent-to-file-a-va-claim/'
		);
		expect(link?.getAttribute('target')).toBe('_blank');
	});

	it('renders a known TAP guide title behind the one shared library link', async () => {
		const { container } = await render(AboutPage);
		expect(container.textContent ?? '').toContain('TAP - Financial Planning for Transition');
		const tapLinks = [...container.querySelectorAll('a')].filter(
			(a) => a.getAttribute('href') === 'https://www.tapevents.mil/resources/documents'
		);
		expect(tapLinks).toHaveLength(1);
	});

	it('keeps the honest sources lede', async () => {
		const { container } = await render(AboutPage);
		const text = container.textContent ?? '';
		expect(text).toMatch(/public US Government work/i);
		expect(text).toMatch(/17 USC/i);
	});

	// CC BY 4.0 requires the credit wherever the crosswalk's matches are shown, and the removal path is the
	// promise made to every company whose public DoD contact the finder shows.
	it('credits the finder data and says how a company asks to be removed', async () => {
		const { container } = await render(AboutPage);
		const text = (container.textContent ?? '').replace(/\s+/g, ' ');
		expect(text).toContain(
			"The SkillBridge finder's job code matches use the O*NET Military Crosswalk from the US Department of Labor (CC BY 4.0). Some company links come from Wikidata (CC0)."
		);
		expect(text).toContain(
			'A company contact shown in the finder is listed publicly by DoD on skillbridge.mil. To ask us to stop showing yours, send a note through Feedback.'
		);
		const feedback = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Feedback');
		expect(feedback?.getAttribute('href')).toBe('/feedback');
	});
});
