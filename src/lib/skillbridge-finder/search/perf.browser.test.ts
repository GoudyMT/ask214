import { describe, it, expect } from 'vitest';
import { INDUSTRIES, type Listing, type RegionFile } from '../contract/listing';
import { STATE_CODES } from '../contract/places';
import type { CrosswalkTable } from '../contract/tables';
import { cleanListing } from '../fixtures/clean';
import { buildSearchIndex, search } from './index';

// The largest division file is 967 KB today; the fixture is a little over that.
const TARGET_BYTES = 990_000;
// A 4x margin on the 100 ms goal: the test machine is not a phone throttled to 4x slower.
const MEDIAN_BUDGET_MS = 25;

/** A small seeded generator so every run builds the same file. */
function mulberry32(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const rng = mulberry32(214);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
const SYLLABLES = [
	'ba',
	'ko',
	'ri',
	'tan',
	'mel',
	'dor',
	'vi',
	'lux',
	'sen',
	'pa',
	'gor',
	'nel',
	'tia',
	'rus',
	'fen',
	'ad',
	'quo',
	'bri',
	'cal',
	'hex',
	'jor',
	'myr',
	'ond',
	'wex',
	'zul',
	'har',
	'ped',
	'sil',
	'tov',
	'umb'
];
const word = () => {
	const w = pick(SYLLABLES) + pick(SYLLABLES) + pick(SYLLABLES);
	return w.charAt(0).toUpperCase() + w.slice(1);
};

const CODES = Array.from(
	{ length: 300 },
	(_, k) => `${10 + (k % 90)}${'ABCDEFGHJK'.charAt(k % 10)}${Math.floor(k / 90)}`
);

function makeListing(i: number): Listing {
	const states = [pick(STATE_CODES), pick(STATE_CODES)];
	return cleanListing({
		i,
		n: `${word()} ${word()} ${pick(['Group', 'Systems', 'Services', 'Labs'])}`,
		p: `${word()} ${pick(['Internship', 'Apprenticeship', 'Fellowship'])} ${word()}`,
		c: word(),
		s: states[0] as (typeof STATE_CODES)[number],
		ls: states,
		r: [`${word()} ${word()}`, `${word()} Technician`],
		ind: [pick(INDUSTRIES)],
		oc: rng() < 0.1 ? 'all' : [pick(CODES), pick(CODES), pick(CODES)]
	});
}

function makeRegionFile(): RegionFile {
	const file: RegionFile = { v: 1, pullDate: '2026-10-21', file: 'south-atlantic', listings: [] };
	// Each listing adds its own text and a comma to the file, so the size is tracked without re-serializing.
	let bytes = JSON.stringify(file).length;
	for (let i = 2000; bytes < TARGET_BYTES; i++) {
		const listing = makeListing(i);
		file.listings.push(listing);
		bytes += JSON.stringify(listing).length + 1;
	}
	return file;
}

const CROSSWALK: CrosswalkTable = {
	v: 1,
	rows: CODES.flatMap((code, k) =>
		(['Army', 'Navy', 'Air Force'] as const).map((branch): [string, string, string, string] => [
			code,
			branch,
			`${11 + (k % 40)}-${1000 + k}.00`,
			`${word()} ${word()} Specialists`
		])
	)
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

describe('search speed on the largest division file', () => {
	it('answers a typed query well inside the budget', () => {
		const file = makeRegionFile();
		expect(JSON.stringify(file).length).toBeGreaterThanOrEqual(TARGET_BYTES);
		const { listings } = file;

		const builtAt = performance.now();
		const index = buildSearchIndex(listings, CROSSWALK);
		const buildMs = performance.now() - builtAt;

		// A listing open to all occupations has no code to search for, so the next one that names codes is used.
		const at = (k: number) => {
			let n = Math.floor((listings.length * k) / 5);
			while (!Array.isArray((listings[n] as Listing).oc)) n++;
			return listings[n] as Listing;
		};
		const orgWord = (l: Listing) => l.n.split(' ')[0] as string;
		const cityOf = (l: Listing) => l.c as string;
		const queries: { text: string; source: Listing }[] = [];
		for (let k = 0; k < 4; k++) {
			const l = at(k + 1);
			const w = orgWord(l);
			const slip = `${w.slice(0, 3)}q${w.slice(4)}`;
			const code = (l.oc as string[])[0] as string;
			queries.push(
				{ text: w, source: l },
				{ text: cityOf(l).slice(0, 4), source: l },
				{ text: slip, source: l },
				{ text: code, source: l },
				{ text: `${w} ${cityOf(l)}`, source: l }
			);
		}
		expect(queries).toHaveLength(20);

		const times: number[] = [];
		for (const { text, source } of queries) {
			const started = performance.now();
			const ids = search(index, text);
			times.push(performance.now() - started);
			// A query that finds nothing would time nothing: each one must find the listing it came from.
			expect(ids).toContain(source.i);
		}

		const med = median(times);
		console.log(
			`search perf: ${listings.length} listings, ${JSON.stringify(file).length} bytes, ` +
				`index build ${buildMs.toFixed(1)} ms, query median ${med.toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms`
		);
		expect(med).toBeLessThan(MEDIAN_BUDGET_MS);
	});
});
