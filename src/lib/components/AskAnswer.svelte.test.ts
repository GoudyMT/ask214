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
		sourceId: 'va_intent_to_file',
		sourceTitle: 'VA - Intent to File',
		url: 'https://www.va.gov/',
		page: 12,
		chunkId: 'va_intent_to_file:0123456789ab'
	}
};

// The section line is what the component names as standing between the answer and an unconditional
// reading: `stripHeadingEcho` strips the heading OUT of the answer text, so if it is not redisplayed the
// condition governing the claim is simply gone. Every fixture omitted `section`, so deleting that
// expression from the template left the whole suite green. The heading here is the real shape - a
// conditional that scopes what follows it - not a tidy label.
const conditionalSectionView: AnswerView = {
	kind: 'extractive',
	answer: {
		text: 'You may qualify for a maximum of 48 months of benefits.',
		passage: 'You may qualify for a maximum of 48 months of benefits.',
		sourceId: 'va_gi_bill',
		sourceTitle: 'VA - GI Bill',
		url: 'https://www.va.gov/',
		section: "If you've completed 2 or more qualifying periods of active duty",
		page: 7,
		chunkId: 'va_gi_bill:0123456789ab'
	}
};

describe('AskAnswer', () => {
	it('extractive: redisplays the section, which carries the governing condition', () => {
		const { container } = render(AskAnswer, { props: { view: conditionalSectionView } });
		expect(container.querySelector('.ask-answer__src')?.textContent).toContain(
			"If you've completed 2 or more qualifying periods of active duty"
		);
	});

	it('extractive: shows the short answer and names its source', () => {
		const { container } = render(AskAnswer, { props: { view: extractiveView } });
		expect(container.textContent).toContain('one year to submit the claim');
		expect(container.textContent).toContain('VA - Intent to File');
		expect(container.textContent).toContain('p. 12');
	});

	// Tier 2. Collapsed by default - a short answer that arrives pre-expanded is not a short answer.
	// Both tiers stay in the DOM for the disclosure contract, so assert VISIBILITY, not textContent.
	it('extractive: hides the fuller passage until asked, then shows it', async () => {
		const { container, getByRole } = render(AskAnswer, { props: { view: extractiveView } });
		const short = container.querySelector('#ask-answer-short') as HTMLElement;
		const passage = container.querySelector('#ask-answer-passage') as HTMLElement;
		expect(passage.hidden).toBe(true);
		expect(short.hidden).toBe(false);
		await getByRole('button', { name: /more detail/i }).click();
		expect(passage.hidden).toBe(false);
		expect(short.hidden).toBe(true);
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

	// PERMANENT, not conditional. The eligibility gate reads the QUESTION's phrasing, so it misses the
	// cases that matter most - "can I use VA health care" renders "You're eligible for VA health care" and
	// never trips it. A quotation is never a determination, so the line is always true and always shown.
	it('extractive: always carries the 38 CFR note, on any question', () => {
		const { container } = render(AskAnswer, { props: { view: extractiveView } });
		const text = container.textContent ?? '';
		expect(text).toContain('not a determination of your eligibility');
		expect(text).toContain('one year to submit the claim'); // the answer is still there
	});

	// VSO claim help is free; the OGC accreditation search also lists attorneys and agents who may charge.
	it('extractive: routes to the canonical free-help destination', () => {
		const { container } = render(AskAnswer, { props: { view: extractiveView } });
		const href = container.querySelector('.ask-answer__note a')?.getAttribute('href') ?? '';
		expect(href).toBe('https://www.va.gov/get-help-from-accredited-representative/');
	});

	// The label must not assert that this IS the answer: measured end to end it contains the answer 50.4%
	// of the time online and 42.2% on device.
	it('extractive: does not claim to be the answer', () => {
		const { container } = render(AskAnswer, { props: { view: extractiveView } });
		expect(container.querySelector('.ask-answer__label')?.textContent).toContain(
			'What the source says'
		);
	});

	// A real disclosure, matching every other one in the app: state announced, target owned by id.
	it('extractive: the expand control is a real disclosure', async () => {
		const { container, getByRole } = render(AskAnswer, { props: { view: extractiveView } });
		const button = container.querySelector('.ask-answer__more') as HTMLButtonElement;
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(button.getAttribute('aria-controls')).toBe('ask-answer-passage');
		expect(container.querySelector('#ask-answer-passage')).not.toBeNull(); // in the DOM while collapsed
		await getByRole('button', { name: /more detail/i }).click();
		expect(
			(container.querySelector('.ask-answer__more') as HTMLButtonElement).getAttribute(
				'aria-expanded'
			)
		).toBe('true');
	});

	// The third tier. The reader already highlights the cited passage offline; the answer block simply had
	// no way in, so on ~4 queries in 10 the only reachable source control opened a DIFFERENT document.
	it('extractive: offers a route into the source it was quoted from', async () => {
		let opened: [string, string | undefined] | null = null;
		const { getByRole } = render(AskAnswer, {
			props: {
				view: extractiveView,
				onOpenSource: (sourceId: string, chunkId?: string) => (opened = [sourceId, chunkId])
			}
		});
		await getByRole('button', { name: /read it in the source/i }).click();
		expect(opened).toEqual(['va_intent_to_file', 'va_intent_to_file:0123456789ab']);
	});

	it('extractive: offers no source route when the answer carries no chunk id', () => {
		const noChunk = {
			kind: 'extractive',
			answer: { ...extractiveView.answer, chunkId: undefined }
		} as AnswerView;
		const { container } = render(AskAnswer, {
			props: { view: noChunk, onOpenSource: () => {} }
		});
		expect(container.textContent).not.toContain('Read it in the source');
	});

	// 90 corpus chunks carry an unbreakable run over 40 chars; without this one overflows 320px by 382px.
	it('extractive: long unbreakable tokens wrap instead of widening the block', () => {
		const { container } = render(AskAnswer, { props: { view: extractiveView } });
		const el = container.querySelector('.ask-answer__text') as HTMLElement;
		expect(['anywhere', 'break-word']).toContain(getComputedStyle(el).overflowWrap);
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
