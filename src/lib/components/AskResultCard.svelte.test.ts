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

	it('does not leave a stranded " -" separator dangling before the ellipsis when the cut lands on one', () => {
		// 23 real words, then a " - " separator (word 24), then more: the compact 24-word cut lands right
		// on the separator, which must be dropped rather than rendered as "...word23 -...".
		const excerpt = [
			...Array.from({ length: 23 }, (_, i) => `w${i}`),
			'-',
			...Array.from({ length: 20 }, (_, i) => `x${i}`)
		].join(' ');
		const { container } = render(AskResultCard, {
			props: { card: fullCard({ excerpt }), variant: 'compact' }
		});
		const text = container.querySelector('.ask-card__excerpt')?.textContent ?? '';
		expect(text.endsWith('...')).toBe(true);
		expect(text.endsWith(' -...')).toBe(false);
		expect(text).toContain('w22...');
	});

	it('caps the lead excerpt at 30 words with an ellipsis', () => {
		// The lead cap dropped from 120 to 30: the card is a signpost to the document, not a reproduction
		// of it. Every cut is marked - an unmarked cut reads as the document's complete statement.
		const long = Array.from({ length: 150 }, (_, i) => `w${i}`).join(' ');
		const { container } = render(AskResultCard, {
			props: { card: fullCard({ excerpt: long }), variant: 'lead' }
		});
		const text = container.querySelector('.ask-card__excerpt')?.textContent ?? '';
		expect(text.endsWith('...')).toBe(true);
		expect(text.split(/\s+/).length).toBe(30);
	});

	it('renders no excerpt paragraph when the chunk cleans to nothing', () => {
		// Real corpus shape: one chunk is nothing but worksheet blank rules, which cleanExcerpt removes
		// entirely. An empty paragraph is an empty node in the accessibility tree, so omit it.
		const { container } = render(AskResultCard, {
			props: { card: fullCard({ excerpt: '' }), variant: 'lead' }
		});
		expect(container.querySelector('.ask-card__excerpt')).toBeNull();
		expect(container.querySelector('.ask-card__title')?.textContent).toBe('VA - Intent to File');
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
