import { describe, it, expect } from 'vitest';
import { shellWidthFor } from './shell-width';

// shellWidthFor maps a SvelteKit route id to the shell content width - the value the root layout
// binds to the --shell-width CSS var on nav/main/footer. The whole shell widens together on a wide
// route (timeline at 1024px); every other route renders at the default 720px column. Pure +
// deterministic so the width rule is unit-tested away from the layout's CSS wiring.
// Source: Timeline Engine design spec (2026-06-03) section 7 (view, Option Y; Session 21 lock).

describe('shellWidthFor', () => {
	it('returns the wide 1024px width for the /timeline route', () => {
		expect(shellWidthFor('/timeline')).toBe('1024px');
	});

	it('returns the default 720px width for non-wide routes', () => {
		expect(shellWidthFor('/')).toBe('720px');
		expect(shellWidthFor('/settings')).toBe('720px');
		expect(shellWidthFor('/about')).toBe('720px');
		expect(shellWidthFor('/wizard')).toBe('720px');
	});

	it('returns the default width when the route id is null (no route resolved yet)', () => {
		// $app/state page.route.id is `string | null`.
		expect(shellWidthFor(null)).toBe('720px');
	});

	it('returns the default width for an unknown route', () => {
		expect(shellWidthFor('/not-a-real-route')).toBe('720px');
	});
});
