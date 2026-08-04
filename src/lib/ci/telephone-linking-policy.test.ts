import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The CitedAnswer inert-prose contract requires that a model-written phone number in an AI summary is never
// a tappable tel: link. iOS / webviews auto-link bare digit runs at the render layer regardless of HTML
// escaping, so the app-wide format-detection:telephone=no meta is the load-bearing control - lock its presence.
describe('phone-number auto-linking policy', () => {
	it('app.html disables telephone auto-detection app-wide', () => {
		const html = readFileSync(new URL('../../app.html', import.meta.url), 'utf8');
		expect(html).toMatch(
			/<meta\s+name=["']format-detection["']\s+content=["']telephone=no["']\s*\/?>/i
		);
	});
});
