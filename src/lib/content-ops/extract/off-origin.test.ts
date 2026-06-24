import { describe, test, expect } from 'vitest';
import { findOffOriginUrls } from './off-origin';

describe('findOffOriginUrls', () => {
	test('flags off-origin src asset URLs, ignores same-origin', () => {
		const html = `<img src="https://evil.example/pixel.gif"><script src="https://www.va.gov/app.js"></script>`;
		const out = findOffOriginUrls(html, 'https://www.va.gov');
		expect(out).toContain('https://evil.example/pixel.gif');
		expect(out).not.toContain('https://www.va.gov/app.js');
	});

	test('does not flag a navigation <a href> link (only resource src= loads)', () => {
		const html = '<p>plain text <a href="https://other.gov/x">link</a></p>';
		expect(findOffOriginUrls(html, 'https://www.va.gov')).toEqual([]);
	});
});
