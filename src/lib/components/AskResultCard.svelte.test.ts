import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect } from 'vitest';
import AskResultCard from './AskResultCard.svelte';
import type { ResultCard } from '$lib/corpus';

function fullCard(over: Partial<ResultCard> = {}): ResultCard {
	return {
		sourceId: 'va_intent_to_file',
		sourceTitle: 'VA - Intent to File',
		section: 'How to submit',
		page: 12,
		excerpt:
			'An intent to file lets you notify VA that you plan to file a claim and sets an effective date.',
		url: 'https://www.va.gov/',
		score: 0.82,
		...over
	};
}

describe('AskResultCard', () => {
	it('renders source title, meta (section + page), excerpt and a safe Open-original link', () => {
		const { container } = render(AskResultCard, { props: { card: fullCard() } });
		expect(container.querySelector('.ask-card__title')?.textContent).toBe('VA - Intent to File');
		const meta = container.querySelector('.ask-card__meta')?.textContent ?? '';
		expect(meta).toContain('How to submit');
		expect(meta).toContain('p. 12');
		const link = container.querySelector('.ask-card__link') as HTMLAnchorElement;
		expect(link.getAttribute('href')).toBe('https://www.va.gov/');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
	});

	it('shows the "Top match" badge + lead styling only for the lead variant', () => {
		const lead = render(AskResultCard, { props: { card: fullCard(), variant: 'lead' } });
		expect(lead.container.querySelector('.ask-card__top-match')).not.toBeNull();
		expect(lead.container.querySelector('.ask-card')?.classList.contains('ask-card--lead')).toBe(
			true
		);

		const compact = render(AskResultCard, { props: { card: fullCard(), variant: 'compact' } });
		expect(compact.container.querySelector('.ask-card__top-match')).toBeNull();
	});

	it('truncates a long excerpt to the word cap with an ellipsis', () => {
		const long = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
		const { container } = render(AskResultCard, {
			props: { card: fullCard({ excerpt: long }), variant: 'compact' }
		});
		const text = container.querySelector('.ask-card__excerpt')?.textContent ?? '';
		expect(text.endsWith('...')).toBe(true);
		expect(text.split(/\s+/).length).toBeLessThanOrEqual(25); // 24 words + the ellipsis token
	});

	it('lead variant shows a fuller ~120-word excerpt (cap raised above the compact 24)', () => {
		const long = Array.from({ length: 150 }, (_, i) => `w${i}`).join(' ');
		const { container } = render(AskResultCard, {
			props: { card: fullCard({ excerpt: long }), variant: 'lead' }
		});
		const text = container.querySelector('.ask-card__excerpt')?.textContent ?? '';
		expect(text.endsWith('...')).toBe(true);
		expect(text.split(/\s+/).length).toBe(120); // lead cap is 120 words (was 60)
	});

	it('omits the meta line when there is no section or page', () => {
		const minimal: ResultCard = {
			sourceId: 's',
			sourceTitle: 'Source',
			excerpt: 'text',
			url: 'https://example.gov/',
			score: 0.5
		};
		const { container } = render(AskResultCard, { props: { card: minimal } });
		expect(container.querySelector('.ask-card__meta')).toBeNull();
	});

	it('shows a "Read full source" button (fires onReadSource) and an official-site link', () => {
		let read = 0;
		const { container } = render(AskResultCard, {
			props: { card: fullCard(), variant: 'lead', onReadSource: () => read++ }
		});
		expect(container.querySelector('.ask-card__link')?.textContent).toContain(
			'View on the official site'
		);
		const btn = container.querySelector('.ask-card__read') as HTMLButtonElement;
		expect(btn).not.toBeNull();
		btn.click();
		flushSync();
		expect(read).toBe(1);
	});
});
