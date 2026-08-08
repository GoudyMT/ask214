import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import CrisisCard from './CrisisCard.svelte';

describe('CrisisCard', () => {
	it('shows the verified Veterans Crisis Line contacts as actionable links', () => {
		const { container } = render(CrisisCard);
		expect(container.textContent).toContain('988');
		expect(container.textContent).toContain('press 1');
		expect(container.textContent).toContain('838255');
		// Native tap-to-call / tap-to-text / official chat - the actual actions, no backend needed.
		expect(container.querySelector('a[href="tel:988"]')).not.toBeNull();
		expect(container.querySelector('a[href="sms:838255"]')).not.toBeNull();
		expect(container.querySelector('a[href^="https://www.veteranscrisisline.net"]')).not.toBeNull();
		expect(container.querySelector('a[href="tel:911"]')).not.toBeNull();
	});

	it('reassures the user the message stayed on-device (privacy)', () => {
		const { container } = render(CrisisCard);
		// Normalize whitespace: the phrase can wrap across lines in the rendered markup.
		expect(container.textContent?.replace(/\s+/g, ' ')).toContain('sent or searched');
	});

	it('announces itself to assistive tech', () => {
		const { container } = render(CrisisCard);
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
	});
});
