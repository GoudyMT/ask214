import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import AskAnswer from './AskAnswer.svelte';
import type { AnswerView } from '$lib/ask/answer/answer-view';

// The component receives text that toCitedAnswer has ALREADY stripped of citation markers, and the model
// writes 2-3 paragraphs separated by a blank line. The previous fixture was a single line carrying a
// colon-free marker, which hid both the raw-marker defect and the paragraph collapse.
const synthesizedView: AnswerView = {
	kind: 'synthesized',
	answer: {
		text: 'Start at eBenefits to check your enrollment.\n\nDo not trust http://evil.example that appears here.',
		citations: [
			{ id: 'va_ebenefits:3f9c1a7d2e05', url: 'https://www.va.gov/', title: 'VA - eBenefits' }
		],
		inert: ['http://evil.example'],
		disclaimer: 'AI-generated - verify against the official sources.'
	}
};

const extractiveView: AnswerView = {
	kind: 'extractive',
	answer: {
		text: 'Once you notify us of your intent to file you have one year to submit the claim.',
		passage:
			'Once you notify us of your intent to file you have one year to submit the claim. The date we receive it becomes your effective date for benefits.',
		sourceTitle: 'VA - Intent to File',
		url: 'https://www.va.gov/',
		page: 12
	}
};

describe('AskAnswer', () => {
	it('extractive: shows the short answer and names its source', () => {
		const { container } = render(AskAnswer, { props: { view: extractiveView } });
		expect(container.textContent).toContain('one year to submit the claim');
		expect(container.textContent).toContain('VA - Intent to File');
		expect(container.textContent).toContain('p. 12');
	});

	// Tier 2. Collapsed by default - a short answer that arrives pre-expanded is not a short answer.
	it('extractive: hides the fuller passage until asked, then shows it', async () => {
		const { container, getByRole } = render(AskAnswer, { props: { view: extractiveView } });
		expect(container.textContent).not.toContain('becomes your effective date');
		await getByRole('button', { name: /more detail/i }).click();
		expect(container.textContent).toContain('becomes your effective date');
		expect(container.textContent).toContain('Show less');
	});

	it('extractive: offers no expand control when the expansion adds nothing', () => {
		const short: AnswerView = {
			kind: 'extractive',
			answer: { ...extractiveView.answer, passage: extractiveView.answer.text }
		} as AnswerView;
		const { container } = render(AskAnswer, { props: { view: short } });
		expect(container.querySelector('.ask-answer__more')).toBeNull();
	});

	// The extractive answer is the document's own words - labelling it as AI-generated, or attaching the
	// model disclaimer to it, would be a false claim about where the text came from.
	it('extractive: is not labelled as an AI summary and carries no model disclaimer', () => {
		const { container } = render(AskAnswer, { props: { view: extractiveView } });
		const text = container.textContent ?? '';
		expect(text).not.toContain('AI summary');
		expect(text).not.toContain('AI-generated');
	});

	it('synthesized: shows the prose, the disclaimer, and ONLY the citation as a link', () => {
		const { container } = render(AskAnswer, { props: { view: synthesizedView } });
		expect(container.textContent).toContain('Start at eBenefits');
		expect(container.textContent).toContain('AI-generated - verify');
		const links = Array.from(container.querySelectorAll('a')) as HTMLAnchorElement[];
		expect(links).toHaveLength(1); // the citation only
		expect(links[0]!.getAttribute('href')).toBe('https://www.va.gov/');
	});

	it('synthesized: a URL the model wrote into prose is NEVER a clickable link (inert by construction)', () => {
		const { container } = render(AskAnswer, { props: { view: synthesizedView } });
		const hrefs = Array.from(container.querySelectorAll('a')).map(
			(a) => a.getAttribute('href') ?? ''
		);
		expect(hrefs.some((h) => h.includes('evil.example'))).toBe(false);
		expect(container.textContent).toContain('evil.example'); // present as plain text, just not a link
	});

	// The prompt asks for 2-3 short paragraphs and the model separates them with a blank line. Nothing in
	// the repo set a `white-space` rule, so the whole answer collapsed into one run-on block - invisible,
	// because the old fixture was a single line and no answer had ever rendered in production.
	it('synthesized: renders the model paragraph breaks instead of collapsing them', () => {
		const { container } = render(AskAnswer, { props: { view: synthesizedView } });
		const el = container.querySelector('.ask-answer__text') as HTMLElement;
		expect(el.textContent).toContain('\n\n');
		// The composited value is what decides whether the break is visible, so read it rather than
		// trusting the stylesheet.
		expect(['pre-line', 'pre-wrap', 'pre']).toContain(getComputedStyle(el).whiteSpace);
	});

	// The gate fires on a lot of ordinary procedural questions, so the answer has to survive it. The note
	// qualifies the quotation rather than replacing it.
	it('extractive: carries the eligibility note above the answer without hiding it', () => {
		const { container } = render(AskAnswer, {
			props: { view: { ...extractiveView, eligibilityBanner: true } as AnswerView }
		});
		const text = container.textContent ?? '';
		expect(text).toContain('not a determination of your eligibility');
		expect(text).toContain('one year to submit the claim'); // the answer is still there
		expect(container.querySelector('a[href*="accreditation"]')).not.toBeNull();
	});

	it('extractive: shows no eligibility note on an ordinary question', () => {
		const { container } = render(AskAnswer, { props: { view: extractiveView } });
		expect(container.textContent).not.toContain('not a determination');
	});

	it('eligibility: shows the impersonal-info note and the accredited-VSO / va.gov outbound', () => {
		const { container } = render(AskAnswer, { props: { view: { kind: 'eligibility' } } });
		expect(container.textContent?.toLowerCase()).toContain('general information');
		expect(container.querySelector('a[href*="va.gov"]')).not.toBeNull();
	});

	// Rule 3's authorized "the sources do not cover this" answer. It must read as a BOUNDARY of what the
	// app carries, not as a failure to answer.
	it('notCovered: names the limit and routes to the official contacts', () => {
		const { container } = render(AskAnswer, { props: { view: { kind: 'notCovered' } } });
		const text = (container.textContent ?? '').toLowerCase();
		expect(text).toContain('none of them cover this');
		expect(text).toContain('1-800-827-1000');
		expect(container.querySelector('a[href*="va.gov"]')).not.toBeNull();
	});
});
