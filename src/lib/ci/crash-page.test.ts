import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The page shown when the app itself fails. Its one line is the page's heading, so a screen reader user reaches
// what went wrong with the usual heading keys, and it is drawn at the size of the text around it, as before.
describe('the crash page', () => {
	const html = readFileSync(join(process.cwd(), 'src/error.html'), 'utf8');

	it('makes its line the page heading', () => {
		expect(html).toContain('<h1>%sveltekit.status% - %sveltekit.error.message%</h1>');
		expect(html).not.toContain('<p>');
	});

	it('draws the heading at the size of body text', () => {
		expect(html).toMatch(/h1\{[^}]*font:inherit/);
	});
});
