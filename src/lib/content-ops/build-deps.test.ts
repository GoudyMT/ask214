import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IMPORT_GAP } from '../ci/pii-policy';

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

// An import of a lib: the bare specifier, a subpath or a Vite suffix (the dep followed by a closing quote, a '/', '?' or
// '#'), so 'axe-core/axe.min.js' and 'axe-core?raw' are caught, not just 'axe-core'. A backtick counts only as the first
// string inside import(: comments use backticks to name a lib. (The deps carry no regex-special chars, so no escaping
// is needed.)
const BUILD_ONLY_IMPORT = new Map<string, RegExp>();
for (const dep of BUILD_ONLY) {
	BUILD_ONLY_IMPORT.set(
		dep,
		new RegExp(
			'[' +
				QUOTES +
				']' +
				dep +
				'([/?#' +
				QUOTES +
				'])|import' +
				IMPORT_GAP +
				'[(]' +
				IMPORT_GAP +
				'[^' +
				QUOTES +
				'`)/]*`' +
				dep +
				'[/?#`]'
		)
	);
}

function importsBuildOnly(text: string, dep: string): boolean {
	return BUILD_ONLY_IMPORT.get(dep)?.test(text) ?? false;
}

/** Any static form: a re-export, a wrapped import, a subpath or a Vite suffix ships the library all the same. */
function importsPdfStatically(text: string): boolean {
	return new RegExp(
		'(?:from|import)' + IMPORT_GAP + '[' + QUOTES + ']' + LAZY_ONLY + '[/?#' + QUOTES + ']'
	).test(text);
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
		expect(importsBuildOnly('import(/* see "x" (y) */ `axe-core`);', 'axe-core')).toBe(true);
		expect(importsBuildOnly('import(dev ? `axe-core` : `./y`);', 'axe-core')).toBe(true);
		expect(importsBuildOnly('import(base + `axe-core`);', 'axe-core')).toBe(true);
		expect(importsBuildOnly(['import(', '// note', '`axe-core`', ')'].join(LF), 'axe-core')).toBe(
			true
		);
	});

	test('the scan leaves a comment that names a lib in backticks alone', () => {
		expect(
			importsBuildOnly('// the import(x) of `axe-core` runs in the E2E suite', 'axe-core')
		).toBe(false);
	});

	test('the pdf check reads every static form, and allows a dynamic one', () => {
		for (const form of [
			"import url from 'pdfjs-dist?url';",
			"import 'pdfjs-dist?raw';",
			"export { getDocument } from 'pdfjs-dist';",
			"export { default } from 'pdfjs-dist/build/pdf.worker.mjs?url';",
			['import {', 'getDocument', "} from /* @vite-ignore */ 'pdfjs-dist';"].join(LF)
		]) {
			expect(importsPdfStatically(form), form).toBe(true);
		}
		expect(importsPdfStatically(['// loaded from', "// 'pdfjs-dist' on demand", ''].join(LF))).toBe(
			false
		);
		expect(importsPdfStatically("const u = import('pdfjs-dist?url');")).toBe(false);
		expect(importsPdfStatically("type P = typeof import('pdfjs-dist');")).toBe(false);
	});

	test('the pdf runtime is reachable only behind a dynamic import', () => {
		const offenders: string[] = [];
		for (const file of tsFiles('src')) {
			const text = readFileSync(file, 'utf8');
			// A static import pulls the library into whatever chunk the importer lands in, which for a
			// component in the app shell means every visitor downloads and parses 450 kB of it. Only
			// `import('pdfjs-dist')` and the type-position `typeof import('pdfjs-dist')` are permitted.
			const statik = new RegExp('(^|\\n)\\s*import\\s[^\\n]*[\'"]' + LAZY_ONLY + '([\'"/])');
			if (statik.test(text) || importsPdfStatically(text)) {
				offenders.push(`${file} -> static import of ${LAZY_ONLY}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
