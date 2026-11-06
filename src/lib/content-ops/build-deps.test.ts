import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The build-only libs must NEVER be imported by a src/ runtime module: they execute only on dev/CI (the
// content-ops/*.mjs scripts, and axe-core in the E2E suite), so a runtime vuln in one of them cannot reach a
// shipped user, and none of them can join the client build.
const BUILD_ONLY = ['linkedom', 'yaml', 'playwright', 'axe-core'];
const QUOTES = ['"', "'"].join('');

// `pdfjs-dist` LEFT this list when the reader began rendering the source documents, which happens in the
// browser and therefore cannot be done by a build-time library. That is a real reduction in what this file
// guarantees: a vulnerability in it can now reach a user. Two things replace the lost protection, and the
// weaker of them is still worth asserting - it must never enter the app shell's static graph, so it is
// fetched only by someone who opened a document, and a passive visit never executes a byte of it.
const LAZY_ONLY = 'pdfjs-dist';
const LF = String.fromCharCode(10);

/**
 * Whether the text imports a lib: the bare specifier, a subpath or a Vite suffix (the dep followed by a closing quote, a
 * '/', '?' or '#'), so 'axe-core/axe.min.js' and 'axe-core?raw' are caught, not just 'axe-core'. A backtick counts only
 * as the first string inside import(: comments use backticks to name a lib. (The deps carry no regex-special chars, so
 * no escaping is needed.)
 */
function importsBuildOnly(text: string, dep: string): boolean {
	return new RegExp(
		'[' +
			QUOTES +
			']' +
			dep +
			'([/?#' +
			QUOTES +
			'])|import[(][^' +
			QUOTES +
			'`)]*`' +
			dep +
			'[/?#`]'
	).test(text);
}

/** A static import of the PDF library with a Vite suffix ships it as surely as the bare name does. */
function importsPdfWithSuffix(text: string): boolean {
	return new RegExp('(?:from|import)[ ]*[' + QUOTES + ']' + LAZY_ONLY + '[?#]').test(text);
}

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...tsFiles(p));
		else if (/\.([cm]?[jt]s|[jt]sx|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
	}
	return out;
}

describe('build-only dependency isolation', () => {
	test('no src/ module imports a build-only lib', () => {
		const offenders: string[] = [];
		for (const file of tsFiles('src')) {
			const text = readFileSync(file, 'utf8');
			for (const dep of BUILD_ONLY) {
				if (importsBuildOnly(text, dep)) offenders.push(`${file} -> ${dep}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test('the scan reads a template import with a bundler comment before it', () => {
		expect(importsBuildOnly('const a = import(/* @vite-ignore */ `axe-core`);', 'axe-core')).toBe(
			true
		);
		expect(
			importsBuildOnly(
				['import(', '\t/* @vite-ignore */', '\t`axe-core/axe.min.js`', ')'].join(LF),
				'axe-core'
			)
		).toBe(true);
	});

	test('the scan leaves a comment that names a lib in backticks alone', () => {
		expect(
			importsBuildOnly('// the import(x) of `axe-core` runs in the E2E suite', 'axe-core')
		).toBe(false);
	});

	test('the pdf check reads a static import with a Vite suffix, and allows a dynamic one', () => {
		expect(importsPdfWithSuffix("import url from 'pdfjs-dist?url';")).toBe(true);
		expect(importsPdfWithSuffix("import 'pdfjs-dist?raw';")).toBe(true);
		expect(importsPdfWithSuffix("const u = import('pdfjs-dist?url');")).toBe(false);
	});

	test('the pdf runtime is reachable only behind a dynamic import', () => {
		const offenders: string[] = [];
		for (const file of tsFiles('src')) {
			const text = readFileSync(file, 'utf8');
			// A static import pulls the library into whatever chunk the importer lands in, which for a
			// component in the app shell means every visitor downloads and parses 450 kB of it. Only
			// `import('pdfjs-dist')` and the type-position `typeof import('pdfjs-dist')` are permitted.
			const statik = new RegExp('(^|\\n)\\s*import\\s[^\\n]*[\'"]' + LAZY_ONLY + '([\'"/])');
			if (statik.test(text) || importsPdfWithSuffix(text)) {
				offenders.push(`${file} -> static import of ${LAZY_ONLY}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
