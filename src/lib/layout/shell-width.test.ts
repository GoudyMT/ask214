import { describe, it, expect } from 'vitest';
import { shellWidthFor } from './shell-width';

// shellWidthFor returns ONE shell content width for every route (Option 1, S25) - the value the root
// layout binds to --shell-width on nav/main/footer - so moving between pages never jumps. Responsive
// width is the layout's max-width + auto margins (fluid below the cap); fluid headings (clamp, app.css)
// scale large text on small screens.
describe('shellWidthFor', () => {
	it('returns one consistent width for every route (no page-to-page jump)', () => {
		const W = '900px';
		expect(shellWidthFor('/')).toBe(W);
		expect(shellWidthFor('/timeline')).toBe(W);
		expect(shellWidthFor('/ask')).toBe(W);
		expect(shellWidthFor('/settings')).toBe(W);
		expect(shellWidthFor('/about')).toBe(W);
	});

	it('returns the width even when the route id is null (no route resolved yet)', () => {
		expect(shellWidthFor(null)).toBe('900px');
	});
});
