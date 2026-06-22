import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The A2 build-only libs must NEVER be imported by a src/ runtime module: they execute only at build
// time on dev/CI (in content-ops/capture-extract.mjs), so a runtime vuln in one of them cannot reach a
// shipped user. Mirrors A1's `yaml` isolation. This guards against a future regression that pulls one
// into the runtime surface.
const BUILD_ONLY = ['pdfjs-dist', '@mozilla/readability', 'linkedom'];

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
				if (text.includes(`'${dep}'`) || text.includes(`"${dep}"`))
					offenders.push(`${file} -> ${dep}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
