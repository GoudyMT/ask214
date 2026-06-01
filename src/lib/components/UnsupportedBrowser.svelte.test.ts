import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import UnsupportedBrowser from './UnsupportedBrowser.svelte';

describe('UnsupportedBrowser', () => {
	it('renders the human reason + the known-good browser list', () => {
		const { container } = render(UnsupportedBrowser, { props: { cause: 'indexed-db' } });
		expect(container.textContent).toContain('securely');
		expect(container.textContent).toContain('Chrome');
		expect(container.textContent).toContain('Safari');
		expect(container.textContent).toContain('Edge');
	});

	it('shows the technical cause in a muted detail line, not the headline', () => {
		const { container } = render(UnsupportedBrowser, { props: { cause: 'navigator-locks' } });
		expect(container.textContent).toContain('navigator-locks');
		expect(container.querySelector('h1')?.textContent).not.toContain('navigator-locks');
	});

	it('offers no primary action (hard stop - nothing to do in-app)', () => {
		const { container } = render(UnsupportedBrowser, { props: { cause: 'subtle-crypto' } });
		expect(container.querySelector('button')).toBeNull();
		expect(container.querySelector('a')).toBeNull();
	});
});
