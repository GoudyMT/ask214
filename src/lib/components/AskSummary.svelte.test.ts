import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import AskSummary from './AskSummary.svelte';
import type { SynthesisView } from '$lib/ask/synthesis/synthesis-view';

// The component receives text that toCitedAnswer has ALREADY stripped of citation markers, and the model
// writes 2-3 paragraphs separated by a blank line. The previous fixture was a single line carrying a
// colon-free marker, which hid both the raw-marker defect and the paragraph collapse.
const answerView: SynthesisView = {
	kind: 'answer',
	answer: {
		text: 'Start at eBenefits to check your enrollment.\n\nDo not trust http://evil.example that appears here.',
		citations: [
			{ id: 'va_ebenefits:3f9c1a7d2e05', url: 'https://www.va.gov/', title: 'VA - eBenefits' }
		],
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

	// The prompt asks for 2-3 short paragraphs and the model separates them with a blank line. Nothing in
	// the repo set a `white-space` rule, so the whole answer collapsed into one run-on block - invisible,
	// because this fixture was a single line and no answer had ever rendered in production.
	it('answer: renders the model paragraph breaks instead of collapsing them', () => {
		const { container } = render(AskSummary, { props: { view: answerView } });
		const el = container.querySelector('.ask-summary__text') as HTMLElement;
		expect(el.textContent).toContain('\n\n');
		// The composited value is what decides whether the break is visible, so read it rather than
		// trusting the stylesheet.
		expect(['pre-line', 'pre-wrap', 'pre']).toContain(getComputedStyle(el).whiteSpace);
	});

	// A crisis turn shows the shipped CrisisCard, not the model's own wording. The model classifies; this
	// component supplies the words, and they are the same verified numbers the keyword pre-gate shows.
	it('crisis: renders the crisis card with the verified contact routes', () => {
		const { container } = render(AskSummary, { props: { view: { kind: 'crisis' } } });
		const text = container.textContent ?? '';
		expect(text).toContain('988');
		expect(text).toContain('838255');
		expect(container.querySelector('a[href="tel:988"]')).not.toBeNull();
	});

	// Rule 3's authorized "the sources do not cover this" answer. It must read as a BOUNDARY of what the
	// app carries, not as a failure to answer.
	it('notCovered: names the limit and routes to the official contacts', () => {
		const { container } = render(AskSummary, { props: { view: { kind: 'notCovered' } } });
		const text = (container.textContent ?? '').toLowerCase();
		expect(text).toContain('none of them cover this');
		expect(text).toContain('1-800-827-1000');
		expect(container.querySelector('a[href*="va.gov"]')).not.toBeNull();
	});
});
