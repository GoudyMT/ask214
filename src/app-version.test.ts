import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The root layout gets the version as plain text before Svelte compiles; any other code reads the same value through
// Vite's define, so a later use outside the footer works instead of throwing a ReferenceError.
describe('__APP_VERSION__', () => {
	it("is package.json's version wherever the code reads it", () => {
		const { version } = JSON.parse(readFileSync('package.json', 'utf-8')) as { version: string };
		expect(typeof __APP_VERSION__ === 'undefined' ? undefined : __APP_VERSION__).toBe(version);
	});
});
