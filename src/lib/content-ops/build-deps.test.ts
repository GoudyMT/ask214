import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The build-only libs must NEVER be imported by a src/ runtime module: they execute only at build time on
// dev/CI (the content-ops/*.mjs scripts), so a runtime vuln in one of them cannot reach a shipped user.
const BUILD_ONLY = ['linkedom', 'yaml', 'playwright'];

// `pdfjs-dist` LEFT this list when the reader began rendering the source documents, which happens in the
// browser and therefore cannot be done by a build-time library. That is a real reduction in what this file
// guarantees: a vulnerability in it can now reach a user. Two things replace the lost protection, and the
// weaker of them is still worth asserting - it must never enter the app shell's static graph, so it is
// fetched only by someone who opened a document, and a passive visit never executes a byte of it.
const LAZY_ONLY = 'pdfjs-dist';

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
	test('no src/ module imports a build-only lib', () => {
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

	test('the pdf runtime is reachable only behind a dynamic import', () => {
		const offenders: string[] = [];
		for (const file of tsFiles('src')) {
			const text = readFileSync(file, 'utf8');
			// A static import pulls the library into whatever chunk the importer lands in, which for a
			// component in the app shell means every visitor downloads and parses 450 kB of it. Only
			// `import('pdfjs-dist')` and the type-position `typeof import('pdfjs-dist')` are permitted.
			const statik = new RegExp('(^|\\n)\\s*import\\s[^\\n]*[\'"]' + LAZY_ONLY + '([\'"/])');
			if (statik.test(text)) offenders.push(`${file} -> static import of ${LAZY_ONLY}`);
		}
		expect(offenders).toEqual([]);
	});
});
