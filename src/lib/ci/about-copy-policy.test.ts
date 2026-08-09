import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The About page tells a first-time reader what the app is, so its claims must match the shipped reality.
// The corpus is built and every answer cites its source, so the page must not promise a source list as
// future work, and must state the sources honestly: public US-gov work, cited on each answer.
describe('About page sources copy is honest', () => {
	// Collapse whitespace so the assertions match regardless of how the markup is line-wrapped.
	const about = readFileSync(
		new URL('../../routes/about/+page.svelte', import.meta.url),
		'utf8'
	).replace(/\s+/g, ' ');

	it('does not promise a source list as future work (the corpus is shipped)', () => {
		expect(about).not.toMatch(/will be published/i);
		expect(about).not.toMatch(/when the corpus is built/i);
	});

	it('states the source provenance and that answers cite their sources', () => {
		expect(about).toMatch(/public US Government work/i);
		expect(about).toMatch(/17 USC/i);
		expect(about).toMatch(/cite/i);
	});
});
