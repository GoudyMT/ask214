import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/*
 * The SkillBridge listings carry real people's work emails. The finder's tests are built on synthetic copies, and
 * this guard keeps it that way: any email address in src/, tests/ or the weekly pipeline's folder must use a
 * reserved example domain or one of the few synthetic or own domains listed here, so a real contact pasted into a
 * fixture fails the suite. The rest of content-ops is left out: its git-ignored capture folders hold real
 * government addresses from the published sources.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNED = ['src', 'tests', 'content-ops/skillbridge'];
const TEXT_FILE_RE = /\.(ts|js|mjs|cjs|svelte|json|html|txt|md|csv)$/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

// Reserved for documentation and tests (RFC 2606 / RFC 6761); subdomains included.
const RESERVED = [
	'example.com',
	'example.org',
	'example.net',
	'example',
	'test',
	'invalid',
	'local'
];
// Not reserved, but known synthetic or our own: test addresses already in older suites, the app's own
// feedback address, and the sign-off line Dependabot writes.
const ALLOWED = new Set(['b.co', 'z.co', 'y.z', 'ask214.com', 'github.com']);

function isAllowedDomain(domain: string): boolean {
	const d = domain.toLowerCase();
	// A package version such as `name@1.0.0` is not an address.
	if (/^\d+(\.\d+)+$/.test(d)) return true;
	return ALLOWED.has(d) || RESERVED.some((r) => d === r || d.endsWith(`.${r}`));
}

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (TEXT_FILE_RE.test(name)) yield path;
	}
}

describe('no real contact addresses in the repo', () => {
	it('every email address in src/, tests/ and content-ops/skillbridge/ uses an example or known synthetic domain', () => {
		const found: string[] = [];
		for (const top of SCANNED)
			for (const file of walk(join(ROOT, top)))
				for (const match of readFileSync(file, 'utf8').matchAll(EMAIL_RE))
					if (!isAllowedDomain(match[1] ?? ''))
						found.push(`${relative(ROOT, file)}: ${match[1] ?? ''}`);
		expect(found).toEqual([]);
	});
});
