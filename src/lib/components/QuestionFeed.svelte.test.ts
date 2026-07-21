import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect } from 'vitest';
import QuestionFeed from './QuestionFeed.svelte';
import { EXAMPLE_QUESTIONS } from '$lib/ask/example-questions';

describe('QuestionFeed', () => {
	it('renders an interactive pill per curated question', () => {
		const { container } = render(QuestionFeed, { props: { onPick: () => {} } });
		// Real (interactive) pills only - the auto-scroll clones added for the seamless loop are aria-hidden.
		const pills = container.querySelectorAll('.q-feed__pill:not([aria-hidden="true"])');
		expect(pills.length).toBe(EXAMPLE_QUESTIONS.length);
	});

	it('clicking a pill calls onPick with that question', () => {
		let picked: string | null = null;
		const { container } = render(QuestionFeed, { props: { onPick: (q: string) => (picked = q) } });
		(container.querySelector('.q-feed__pill') as HTMLButtonElement).click();
		flushSync();
		expect(picked).toBe(EXAMPLE_QUESTIONS[0]);
	});
});
