import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

// The finder lists programs; it never tells a person what they qualify for (38 CFR 14.629), never ranks or marks a
// listing by their rate or rank, and keeps what it holds out of the places a browser leaves readable (web storage,
// a page snapshot) and out of raw HTML. Each rule reads the finder's own non-test source, comments stripped, so a
// line added later is held to it too.
const FINDER_DIRS = ['src/lib/skillbridge-finder', 'src/routes/skillbridge'];

const isSource = (name: string) =>
	/\.(?:ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name);

function sourcesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		// Fixtures are test data shaped like the raw site, prose included; none of it ships.
		if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : sourcesUnder(full);
		return isSource(entry.name) ? [full] : [];
	});
}

function collect(): { path: string; content: string }[] {
	return FINDER_DIRS.flatMap((dir) => sourcesUnder(join(process.cwd(), dir))).map((path) => ({
		path,
		content: readFileSync(path, 'utf8')
	}));
}

/** The source with its block, line and markup comments removed: a rule names what ships, not what is explained. */
function withoutComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

// The eligibility gate's stems (src/lib/ask/synthesis/eligibility-gate.ts:28), and "fit" said of a person.
const CLAIM_WORDS = /\b(?:dis|in|un|re)?(?:qualif|eligib|entitl)\w*|\bfits?\b|\bfor you\b/gi;
// A word that starts with rate or rank, or holds one in camel case.
const RATE_WORDS = /\b(?:rate|rank)\w*|\b\w*(?:Rate|Rank)\w*/g;
const STORAGE_WORDS = /\b(?:sessionStorage|localStorage|snapshot)\b|\{@html\b/g;

function hits(content: string, pattern: RegExp): string[] {
	return withoutComments(content).match(pattern) ?? [];
}

function scan(files: { path: string; content: string }[], pattern: RegExp): string[] {
	return files.flatMap((file) =>
		hits(file.content, pattern).map((word) => `${basename(file.path)}: ${word}`)
	);
}

describe('the finder copy and claim policy', () => {
	it('says nothing about what a person qualifies for or fits', () => {
		expect(scan(collect(), CLAIM_WORDS)).toEqual([]);
	});

	it('names no rate or rank, so nothing sorts, filters or marks by them', () => {
		expect(scan(collect(), RATE_WORDS)).toEqual([]);
	});

	it('uses no web storage, page snapshot or raw HTML', () => {
		expect(scan(collect(), STORAGE_WORDS)).toEqual([]);
	});

	// A folder read that matched nothing would let every scan pass on an empty list.
	it('reads the route, the screens and the stores, and none of their tests', () => {
		const names = collect().map((f) => basename(f.path));
		expect(names).toEqual(
			expect.arrayContaining([
				'+page.svelte',
				'store.svelte.ts',
				'match.ts',
				'CompareTable.svelte',
				'home-row.ts'
			])
		);
		expect(names.filter((name) => name.includes('.test.'))).toEqual([]);
	});

	it.each([
		['an eligibility word', '<p>You are eligible for this program.</p>', ['eligible']],
		['a denial stem', "const NOTE = 'Some members are disqualified.';", ['disqualified']],
		['"fits"', '<span>This program fits you</span>', ['fits']],
		['"for you"', "const LEDE = 'Programs picked for you';", ['for you']]
	])('flags %s, and not the same words in a comment', (_name, content, words) => {
		expect(hits(content, CLAIM_WORDS)).toEqual(words);
		expect(hits(`<!-- ${content} -->`, CLAIM_WORDS)).toEqual([]);
		expect(hits(`// ${content}`, CLAIM_WORDS)).toEqual([]);
	});

	it.each([
		[
			'a sort by rate',
			'rows.sort((a, b) => matchesRate(a) - matchesRate(b));',
			['matchesRate', 'matchesRate']
		],
		['a highlight by rank', '<li class:mine={row.rank === rank}>', ['rank', 'rank']]
	])('flags %s', (_name, content, words) => {
		expect(hits(content, RATE_WORDS)).toEqual(words);
	});

	it.each([
		['localStorage', "localStorage.setItem('zip', zip);", ['localStorage']],
		['sessionStorage', "sessionStorage.getItem('q');", ['sessionStorage']],
		['a snapshot', 'export const snapshot = { capture, restore };', ['snapshot']],
		['raw HTML', '<p>{@html row.n}</p>', ['{@html']]
	])('flags %s', (_name, content, words) => {
		expect(hits(content, STORAGE_WORDS)).toEqual(words);
	});

	// A URL in a string is not a comment: stripping it would hide what follows on the line.
	it('keeps a URL and the rest of its line', () => {
		expect(hits("const U = 'https://x.test'; localStorage.clear();", STORAGE_WORDS)).toEqual([
			'localStorage'
		]);
	});
});
