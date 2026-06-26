import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The build-only libs must NEVER be imported by a src/ runtime module: they execute only at build time on
// dev/CI (the content-ops/*.mjs scripts), so a runtime vuln in one of them cannot reach a shipped user.
const BUILD_ONLY = ['pdfjs-dist', '@mozilla/readability', 'linkedom', 'yaml', 'playwright'];

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...tsFiles(p));
		else if (/\.(ts|svelte|js)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
	}
	return out;
}

describe('build-only dependency isolation', () => {
	test('no src/ module imports an A2 build-only lib', () => {
		const offenders: string[] = [];
		for (const file of tsFiles('src')) {
			const text = readFileSync(file, 'utf8');
			for (const dep of BUILD_ONLY) {
				// Match the bare specifier OR a subpath import (dep followed by a closing quote or a '/'), so
				// e.g. 'pdfjs-dist/legacy/build/pdf.mjs' is caught, not just 'pdfjs-dist'. (The deps carry no
				// regex-special chars, so no escaping is needed.)
				const re = new RegExp('[\'"]' + dep + '([\'"/])');
				if (re.test(text)) offenders.push(`${file} -> ${dep}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
