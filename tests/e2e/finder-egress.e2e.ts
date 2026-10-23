import { expect, test, type Request } from '@playwright/test';
import { cleanListing } from '../../src/lib/skillbridge-finder/fixtures/clean';
import type {
	ChangesFile,
	IdsFile,
	IndexFile,
	RegionFile
} from '../../src/lib/skillbridge-finder/contract/listing';
import {
	REGION_FILE_NAMES,
	dataPath,
	type RegionFileName
} from '../../src/lib/skillbridge-finder/contract/places';

// The SkillBridge finder asks the network for fixed file names only. What the person typed - a ZIP, a state, a search -
// only chooses which names, and must appear in no request: not in the address, not in any header, not in a body, in
// no encoding a string check can see. The page is walked through the real setup and search with the service worker ON
// and in charge, so the worker's own requests are recorded too (the context sees them). Every /api/ request is
// aborted, so the walk can never send real feedback; a control proves the abort works.
//
// Chromium only, as finder-data-cache.e2e.ts: on Playwright WebKit a route does not answer a fetch made under a worker.

const PULL = '2026-10-21';
const ZIP = '20850';
const STATE_NAME = 'Maryland';
const STATE_CODE = 'MD';
const SEARCH = 'quillfeather';

const inMaryland = (n: number) =>
	cleanListing({
		i: 7000 + n,
		o: 800 + n,
		n: `Fixture Works ${n}`,
		p: 'Records Clerk',
		s: 'MD',
		ls: ['MD'],
		z: '21046',
		fl: PULL,
		dc: '2026-10-10'
	});

const LISTINGS: Partial<Record<RegionFileName, ReturnType<typeof cleanListing>[]>> = {
	'south-atlantic': [inMaryland(1), inMaryland(2), inMaryland(3)]
};

const INDEX: IndexFile = {
	v: 1,
	pullDate: PULL,
	baseline: false,
	baselineDate: '2026-10-07',
	// The size an index declares is a ceiling the file may not pass, so it is generous here.
	files: REGION_FILE_NAMES.map((name) => ({
		name,
		count: LISTINGS[name]?.length ?? 0,
		bytes: 100_000
	}))
};
const IDS: IdsFile = {
	v: 1,
	pullDate: PULL,
	ids: (LISTINGS['south-atlantic'] ?? []).map((l): [number, string] => [l.i, l.fl]),
	aliases: []
};
const CHANGES: ChangesFile = {
	v: 1,
	weeks: [{ pullDate: PULL, added: [], removed: [], newOrgs: [] }]
};

const FILES = new Map<string, unknown>([
	[dataPath({ kind: 'index' }), INDEX],
	[
		dataPath({ kind: 'table', name: 'zips' }),
		{
			v: 1,
			rows: [
				[ZIP, 'MD', 39.1, -77.15],
				['22201', 'VA', 38.88, -77.1]
			]
		}
	],
	[dataPath({ kind: 'ids', pullDate: PULL }), IDS],
	[dataPath({ kind: 'changes', pullDate: PULL }), CHANGES],
	...REGION_FILE_NAMES.map((name): [string, unknown] => [
		dataPath({ kind: 'region', pullDate: PULL, name }),
		{ v: 1, pullDate: PULL, file: name, listings: LISTINGS[name] ?? [] } satisfies RegionFile
	])
]);

/** Every path a client may ask for under /skillbridge-data/, built the one way the app builds them. */
const ALLOWED_DATA_PATHS = new Set<string>([
	dataPath({ kind: 'index' }),
	dataPath({ kind: 'table', name: 'zips' }),
	dataPath({ kind: 'table', name: 'crosswalk' }),
	dataPath({ kind: 'ids', pullDate: PULL }),
	dataPath({ kind: 'changes', pullDate: PULL }),
	...REGION_FILE_NAMES.map((name) => dataPath({ kind: 'region', pullDate: PULL, name }))
]);

/** A URL or body read as the server would read it; unchanged when it is not validly encoded. */
function decoded(text: string): string {
	try {
		return decodeURIComponent(text.replace(/\+/g, ' '));
	} catch {
		return text;
	}
}

/**
 * The ways `value` can sit inside a base64 string: the text's own encoding depends on where it falls among the three-
 * byte groups, so it is encoded at each of the three offsets and the edge characters that depend on a neighbour
 * are cut. Standard and URL-safe alphabets, without padding.
 */
function base64Forms(value: string): string[] {
	const forms: string[] = [];
	for (let pad = 0; pad < 3; pad++) {
		const encoded = Buffer.from('x'.repeat(pad) + value).toString('base64');
		const start = [0, 2, 3][pad] ?? 0;
		const total = pad + value.length;
		const end = encoded.length - ([0, 3, 2][total % 3] ?? 0);
		const form = encoded.slice(start, end).replace(/=+$/, '');
		forms.push(form, form.replace(/\+/g, '-').replace(/\//g, '_'));
	}
	return forms;
}

/** The values as typed, found whatever their case. */
const PLAIN = [ZIP, STATE_NAME, SEARCH].map((s) => s.toLowerCase());
/** The values as base64, where case is part of the code and so is kept. */
const ENCODED = [...base64Forms(ZIP), ...base64Forms(STATE_NAME), ...base64Forms(SEARCH)];
// The state's two letters are too short to look for as a substring; as a whole word they are not.
const STATE_CODE_WORD = new RegExp(`\\b${STATE_CODE}\\b`);

type Sent = { url: string; method: string; headers: string; body: string; fromWorker: boolean };

async function readAll(requests: Request[]): Promise<Sent[]> {
	return Promise.all(
		requests.map(async (request) => ({
			url: request.url(),
			method: request.method(),
			headers: JSON.stringify(await request.allHeaders()),
			body: request.postData() ?? '',
			fromWorker: request.serviceWorker() !== null
		}))
	);
}

function leaksOf(sent: Sent[]): string[] {
	const found: string[] = [];
	for (const r of sent) {
		const text = [
			r.url,
			decoded(r.url),
			r.headers,
			decoded(r.headers),
			r.body,
			decoded(r.body)
		].join('\n');
		const lower = text.toLowerCase();
		for (const value of PLAIN) if (lower.includes(value)) found.push(`${value} in ${r.url}`);
		for (const value of ENCODED) if (text.includes(value)) found.push(`${value} in ${r.url}`);
		if (STATE_CODE_WORD.test(text)) found.push(`${STATE_CODE} in ${r.url}`);
	}
	return found;
}

test('what a person types into the finder reaches no request, with the service worker in charge', async ({
	page,
	context,
	browserName
}) => {
	test.skip(
		browserName === 'webkit',
		'a route does not answer a fetch made under a service worker on Playwright WebKit'
	);
	const requests: Request[] = [];
	context.on('request', (request) => requests.push(request));
	await context.route('**/skillbridge-data/**', (route) => {
		const body = FILES.get(new URL(route.request().url()).pathname);
		return body === undefined
			? route.fulfill({ status: 404, body: 'missing' })
			: route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify(body)
				});
	});
	// Nothing may leave for the API during a walk, feedback least of all.
	await context.route('**/api/**', (route) => route.abort());

	// The worker takes charge before the finder fetches anything, so the fetches go through its bypass answer.
	await page.goto('/');
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
	await page.goto('/skillbridge');
	await expect
		.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
		.toBe(true);

	// The seeded values, through the real screens: a ZIP, then a state, then a search.
	await page.getByLabel('ZIP code or state').fill(ZIP);
	await page.getByRole('button', { name: 'Show programs' }).click();
	await expect(page.getByText(/^\d+ programs?$/)).toBeVisible();
	await page.goto('/skillbridge#setup');
	await page.getByLabel('ZIP code or state').fill(STATE_NAME);
	await page.getByRole('button', { name: 'Show programs' }).click();
	await expect(page.getByRole('button', { name: `Remove In ${STATE_NAME}` })).toBeVisible();
	await page.getByLabel('Search programs').fill(SEARCH);
	await expect(page.getByRole('heading', { name: 'No programs match all of these' })).toBeVisible();
	await page.waitForLoadState('networkidle');

	// Control for the abort: a send to the API fails, so none of the walk's requests could have reached it.
	const control = await page.evaluate(() =>
		fetch('/api/feedback', { method: 'POST', body: '{}' }).then(
			() => 'sent',
			() => 'aborted'
		)
	);
	expect(control).toBe('aborted');

	const sent = await readAll(requests);

	const data = sent.filter((r) => new URL(r.url).pathname.startsWith('/skillbridge-data/'));
	// The control for the check below: the finder did fetch, the index and the ZIP table among the files.
	const dataPaths = new Set(data.map((r) => new URL(r.url).pathname));
	expect(dataPaths).toContain(dataPath({ kind: 'index' }));
	expect(dataPaths).toContain(dataPath({ kind: 'table', name: 'zips' }));
	for (const r of data) {
		const url = new URL(r.url);
		expect(ALLOWED_DATA_PATHS, `${url.pathname} is on the fixed list`).toContain(url.pathname);
		expect(url.search, `no query on ${url.pathname}`).toBe('');
		expect(r.method, `${url.pathname} is a GET`).toBe('GET');
		expect(r.body, `no body on ${url.pathname}`).toBe('');
	}
	// The recording holds the worker's own requests (its page fetches and cache fills) as well as the page's, so the leak
	// check below reads both. The worker passes the data files through, so those come from the page itself.
	expect(sent.some((r) => r.fromWorker)).toBe(true);

	// The only API request is the control.
	expect(sent.filter((r) => r.url.includes('/api/')).map((r) => new URL(r.url).pathname)).toEqual([
		'/api/feedback'
	]);

	expect(leaksOf(sent)).toEqual([]);
});
