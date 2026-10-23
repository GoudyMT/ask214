import { describe, it, expect } from 'vitest';
import { cdp } from 'vitest/browser';
import { INDUSTRIES, type Listing, type RegionFile } from '../contract/listing';
import { STATE_CODES, type StateCode } from '../contract/places';
import type { CrosswalkTable } from '../contract/tables';
import { cleanListing } from '../fixtures/clean';
import { matchListings, type Filters, type Radius } from '../state/match';
import { buildSearchIndex, search } from './index';

// The largest division file is 967 KB today; the fixture is a little over that.
const TARGET_BYTES = 990_000;
// A 4x margin on the 100 ms goal for the unthrottled run: the test machine is not a phone throttled to 4x slower.
const MEDIAN_BUDGET_MS = 25;
/** The goal a person feels, and how much slower than this machine the phone it is judged on is taken to be. */
const GOAL_MS = 100;
const SLOWDOWN = 4;

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
		oc: rng() < 0.1 ? 'all' : [...new Set([pick(CODES), pick(CODES), pick(CODES)])]
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

/** The file, its search index and the queries, built once: the generator is seeded, so every test sees the same. */
let built: ReturnType<typeof build> | undefined;
function build() {
	const file = makeRegionFile();
	const { listings } = file;
	const bytes = JSON.stringify(file).length;

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

	// Most real programs sit at one point in one state, which is what the nearest-first sort works on; the generated
	// ones name two states, so a third are placed at a spread of points across the country.
	const placed = listings.map((l, k) =>
		k % 3 === 0
			? {
					...l,
					ls: [l.s as StateCode],
					la: 25 + ((l.i * 37) % 2400) / 100,
					lo: -124 + ((l.i * 91) % 5700) / 100
				}
			: l
	);
	return { listings, placed, bytes, index, buildMs, queries };
}
const fixture = () => (built ??= build());

/** The time of each typed query; each must find the listing it came from, or it would time nothing. */
function timeSearches(): number[] {
	const { index, queries } = fixture();
	return queries.map(({ text, source }) => {
		const started = performance.now();
		const ids = search(index, text);
		const took = performance.now() - started;
		expect(ids).toContain(source.i);
		return took;
	});
}

const FILTER_SETS: Filters[] = INDUSTRIES.slice(0, 5).map((industry) => ({
	industries: [industry],
	branches: ['Army', 'Navy']
}));
const RADII: Radius[] = [25, 100, 'any'];
const ORIGIN = { la: 38.9, lo: -77.04 };

/** The time of each filter-and-sort: a filter set with a place and a radius, ordered nearest first. */
function timeMatches(): number[] {
	const { placed } = fixture();
	return FILTER_SETS.flatMap((filters) =>
		RADII.map((radius) => {
			const started = performance.now();
			const rows = matchListings(placed, { filters, point: ORIGIN, radius });
			const took = performance.now() - started;
			// An empty answer would time nothing.
			expect(rows.length).toBeGreaterThan(0);
			return took;
		})
	);
}

/** A fixed amount of plain arithmetic, long enough to be read on a coarse clock: it shows how fast the CPU runs. */
function timeSpin(): number {
	const started = performance.now();
	let sum = 0;
	for (let n = 0; n < 20_000_000; n++) sum = (sum + n * 7) % 1_000_003;
	return performance.now() - started + sum * 0;
}

describe('search speed on the largest division file', () => {
	it('answers a typed query well inside the budget', () => {
		const { listings, bytes, buildMs, queries } = fixture();
		expect(bytes).toBeGreaterThanOrEqual(TARGET_BYTES);
		expect(queries).toHaveLength(20);

		const times = timeSearches();
		const med = median(times);
		console.log(
			`search perf: ${listings.length} listings, ${bytes} bytes, ` +
				`index build ${buildMs.toFixed(1)} ms, query median ${med.toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms`
		);
		expect(med).toBeLessThan(MEDIAN_BUDGET_MS);
	});

	// The goal is a result inside 100 ms on a phone that is 4 times slower than this machine, so the browser is
	// told to run 4 times slower and the goal is checked as it stands.
	it('answers a query and a filter-and-sort inside 100 ms at 4x CPU slowdown', async () => {
		fixture();
		const plainSearch = median(timeSearches());
		const plainMatch = median(timeMatches());
		const plainSpin = timeSpin();

		const session = cdp();
		await session.send('Emulation.setCPUThrottlingRate', { rate: SLOWDOWN });
		let slowSearch: number;
		let slowMatch: number;
		let slowSpin: number;
		try {
			slowSearch = median(timeSearches());
			slowMatch = median(timeMatches());
			slowSpin = timeSpin();
		} finally {
			await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
		}
		console.log(
			`perf at ${SLOWDOWN}x: search median ${slowSearch.toFixed(2)} ms (unthrottled ${plainSearch.toFixed(2)}), ` +
				`filter-and-sort median ${slowMatch.toFixed(2)} ms (unthrottled ${plainMatch.toFixed(2)}), ` +
				`fixed workload ${slowSpin.toFixed(1)} ms (unthrottled ${plainSpin.toFixed(1)})`
		);
		// A throttle that did not take would pass the goal on the machine's own speed.
		expect(slowSpin).toBeGreaterThan(plainSpin * 2);
		expect(slowSearch).toBeLessThan(GOAL_MS);
		expect(slowMatch).toBeLessThan(GOAL_MS);
	});
});
