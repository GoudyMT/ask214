import { render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import { describe, it, expect } from 'vitest';
import AppGate from './AppGate.svelte';
import type { ProfileApp } from '../profile/context';

// A trivial children snippet for the ready branch.
const childSnippet = createRawSnippet(() => ({
	render: () => '<p data-testid="app-content">app content</p>'
}));

describe('AppGate', () => {
	it('renders the UnsupportedBrowser screen when status is unsupported', () => {
		const app: ProfileApp = {
			status: 'unsupported',
			store: null,
			timeline: null,
			calendar: null,
			cause: 'indexed-db'
		};
		const { container } = render(AppGate, { props: { app, children: childSnippet } });
		expect(container.textContent).toContain('securely'); // UnsupportedBrowser heading
		expect(container.querySelector('[data-testid="app-content"]')).toBeNull();
	});

	it('renders children (the app shell) while loading - the shell is not gated behind ready', () => {
		const app: ProfileApp = {
			status: 'loading',
			store: null,
			timeline: null,
			calendar: null,
			cause: null
		};
		const { container } = render(AppGate, { props: { app, children: childSnippet } });
		expect(container.querySelector('[data-testid="app-content"]')).not.toBeNull();
	});

	it('renders children when status is ready', () => {
		const app: ProfileApp = {
			status: 'ready',
			store: null,
			timeline: null,
			calendar: null,
			cause: null
		};
		const { container } = render(AppGate, { props: { app, children: childSnippet } });
		expect(container.querySelector('[data-testid="app-content"]')).not.toBeNull();
	});
});
