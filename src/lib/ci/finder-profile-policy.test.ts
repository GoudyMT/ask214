import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { scanForPiiImports, scanForPiiTokens } from './pii-policy';

// Nothing in the finder's list is sorted, filtered or marked by what the person's profile holds (rate, rank, end of
// service, SkillBridge start), so the code that matches, places and orders listings has no such input. The scan
// reads the finder's own non-test source for those field names and for imports of the modules that hold them.
const STATE_DIR = 'src/lib/skillbridge-finder/state';
const SEARCH_DIR = 'src/lib/skillbridge-finder/search';
const STATE_FILES = ['match', 'distance', 'new-rule', 'saved-status', 'select-files'];

const isSource = (name: string) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name);

/** Every word starting with rate, rank or profile, or holding one in camel case, outside comments. */
function profileWords(source: string): string[] {
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	return code.match(/\b(?:rate|rank|profile)\w*|\b\w*(?:Rate|Rank|Profile)\w*/g) ?? [];
}

function collect(): { path: string; content: string }[] {
	const searchDir = join(process.cwd(), SEARCH_DIR);
	const paths = [
		...STATE_FILES.map((name) => join(process.cwd(), STATE_DIR, `${name}.ts`)),
		...readdirSync(searchDir)
			.filter(isSource)
			.map((name) => join(searchDir, name))
	];
	return paths.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
}

describe('the finder code that matches and orders listings', () => {
	it('names no profile field', () => {
		expect(scanForPiiTokens(collect())).toEqual([]);
	});

	// The field scan sees a profile field only as it is read off an object. A screen that hands the person's rank or rate
	// in as a plain argument names no field at all, so these files may not use the words either.
	it('uses no profile word, however it is written', () => {
		expect(collect().flatMap((file) => profileWords(file.content))).toEqual([]);
	});

	it.each([
		['a bare rank parameter', 'export function matchListings(rows, query, rank) {', ['rank']],
		['a camel-case name', 'const userProfile = query.who;', ['userProfile']],
		['a rate compared', 'return rows.filter((r) => r.minRate <= payRate);', ['minRate', 'payRate']]
	])('flags %s, and not the same words in a comment', (_name, content, words) => {
		expect(profileWords(content)).toEqual(words);
		expect(profileWords(`// ${content}`)).toEqual([]);
	});

	it('imports none of the modules that hold personal data', () => {
		expect(scanForPiiImports(collect())).toEqual([]);
	});

	// A folder read that matched nothing would let both scans pass on an empty list.
	it('reads every source file of the search folder and none of its tests', () => {
		const names = collect().map((f) => basename(f.path));
		expect(names).toEqual(expect.arrayContaining(['index.ts', 'typo.ts', 'state-names.ts']));
		expect(names.filter((name) => name.includes('.test.'))).toEqual([]);
	});

	// The scan must see a filter on a profile field however it is written.
	it.each([
		['a dotted read of eaos', 'rows.filter((r) => r.eaos < cutoff);'],
		['a dotted read of skillbridgeStart', 'const from = person.skillbridgeStart;'],
		['a destructured eaos', 'const { eaos } = person;'],
		['a bracket read of rank', "const r = person['rank'];"]
	])('flags %s', (_name, content) => {
		const planted = [{ path: `${STATE_DIR}/match.ts`, content }];
		expect(scanForPiiTokens(planted)).toHaveLength(1);
	});

	it.each([
		['the profile', "import { loadProfile } from '$lib/profile/store';"],
		['the keystore', "import { keystore } from '../../keystore/record';"]
	])('flags an import of %s', (_name, content) => {
		const planted = [{ path: `${SEARCH_DIR}/index.ts`, content }];
		expect(scanForPiiImports(planted)).toHaveLength(1);
	});
});
