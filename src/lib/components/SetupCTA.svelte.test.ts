import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import SetupCTA from './SetupCTA.svelte';

describe('SetupCTA', () => {
	it('renders the locked heading and supporting line', async () => {
		const { container } = await render(SetupCTA);
		expect(container.querySelector('h2')?.textContent).toBe('Set up your profile');
		expect(container.textContent).toContain('separation date');
	});

	it('exposes a "Get started" link to the wizard', async () => {
		const { container } = await render(SetupCTA);
		const link = container.querySelector('a');
		expect(link?.textContent?.trim()).toBe('Get started');
		expect(link?.getAttribute('href')).toBe('/wizard');
	});

	it('renders byte-identical markup on every mount (side-channel defense)', async () => {
		const first = (await render(SetupCTA)).container.innerHTML;
		const second = (await render(SetupCTA)).container.innerHTML;
		expect(second).toBe(first);
	});
});
