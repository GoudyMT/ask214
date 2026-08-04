import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import AskSummary from './AskSummary.svelte';
import type { SynthesisView } from '$lib/ask/synthesis/synthesis-view';

const answerView: SynthesisView = {
	kind: 'answer',
	answer: {
		text: 'Start at eBenefits [va]. Do not trust http://evil.example that appears here.',
		citations: [{ id: 'va', url: 'https://www.va.gov/', title: 'VA - eBenefits' }],
		inert: ['http://evil.example'],
		disclaimer: 'AI-generated - verify against the official sources.'
	}
};

describe('AskSummary', () => {
	it('answer: shows the prose, the disclaimer, and ONLY the citation as a link', () => {
		const { container } = render(AskSummary, { props: { view: answerView } });
		expect(container.textContent).toContain('Start at eBenefits');
		expect(container.textContent).toContain('AI-generated - verify');
		const links = Array.from(container.querySelectorAll('a')) as HTMLAnchorElement[];
		expect(links).toHaveLength(1); // the citation only
		expect(links[0]!.getAttribute('href')).toBe('https://www.va.gov/');
	});

	it('answer: a URL the model wrote into prose is NEVER a clickable link (inert by construction)', () => {
		const { container } = render(AskSummary, { props: { view: answerView } });
		const hrefs = Array.from(container.querySelectorAll('a')).map(
			(a) => a.getAttribute('href') ?? ''
		);
		expect(hrefs.some((h) => h.includes('evil.example'))).toBe(false);
		expect(container.textContent).toContain('evil.example'); // present as plain text, just not a link
	});

	it('eligibility: shows the impersonal-info note and the accredited-VSO / va.gov outbound', () => {
		const { container } = render(AskSummary, { props: { view: { kind: 'eligibility' } } });
		expect(container.textContent?.toLowerCase()).toContain('general information');
		expect(container.querySelector('a[href*="va.gov"]')).not.toBeNull();
	});

	it('refusal: tells the user to read the official sources below', () => {
		const { container } = render(AskSummary, { props: { view: { kind: 'refusal' } } });
		expect(container.textContent?.toLowerCase()).toContain('reliable summary');
	});

	it('unavailable: a small muted note, no banner heading', () => {
		const { container } = render(AskSummary, { props: { view: { kind: 'unavailable' } } });
		expect(container.textContent?.toLowerCase()).toContain('summary unavailable');
	});
});
