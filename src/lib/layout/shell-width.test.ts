import { describe, it, expect } from 'vitest';
import { shellWidthFor } from './shell-width';

// shellWidthFor returns ONE shell content width - the value the root layout binds to --shell-width on
// nav/main/footer - so moving between pages never jumps. It takes no route, so no route can get another
// width. Responsive width is the layout's max-width + auto margins (fluid below the cap); fluid headings
// (clamp, app.css) scale large text on small screens.
describe('shellWidthFor', () => {
	it('returns the one width every page uses', () => {
		expect(shellWidthFor()).toBe('900px');
	});
});
