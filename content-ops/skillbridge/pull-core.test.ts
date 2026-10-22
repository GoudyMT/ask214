import { describe, it, expect } from 'vitest';
import { lookupUrl, robotsDisallows, runPull } from './pull-core.ts';
import type { Clock, Http, HttpReply } from './pull-core.ts';
import { API_ORIGIN, FILTERS_PATH, LOOKUP_PATH, PAUSE_MS, ROBOTS_PATH } from './config.ts';
import type { PullInput, PullOutcome, PullRun } from './types.ts';
import type { ApiListing } from '../../src/lib/skillbridge-finder/contract/api.ts';
import { rawListing } from '../../src/lib/skillbridge-finder/fixtures/raw.ts';

// The pull asks a public server we do not run, so every behaviour here is about being a good guest (pace, name
// ourselves, obey robots.txt, stop at the first sign of a "no") and about never wrongly believing a provider is
// fully seen. The fake server answers from a small model of the real one: it matches the provider name exactly,
// matches `state` as a substring, and hands back at most 150 rows while reporting the true size.

const ROBOTS_URL = API_ORIGIN + ROBOTS_PATH;
const FILTERS_URL = API_ORIGIN + FILTERS_PATH;
const ALL_URL = 'https://api.skillbridge.mil/Location/Lookup?draw=1&start=0&length=150';
const START_MS = 1_000_000;
const CAP = 150;

type Scripted = HttpReply | 'reject';

type World = {
	robots: Scripted;
	providers: [string, ApiListing[]][];
	filtersProviders: string[];
	states: string[];
	totalN: number;
	totalPositions: string;
	/** Replies given instead of the model's, per URL, in order; once used up the model answers. */
	scripts: Map<string, Scripted[]>;
};

function json(body: unknown): HttpReply {
	return {
		status: 200,
		contentType: 'application/json; charset=utf-8',
		body: JSON.stringify(body)
	};
}

function rowsOf(first: number, count: number, over: Partial<ApiListing> = {}): ApiListing[] {
	return Array.from({ length: count }, (_, i) => rawListing({ id: first + i, ...over }));
}

function makeWorld(over: Partial<World> = {}): World {
	const providers = over.providers ?? [['Acme Example', rowsOf(1, 3)]];
	const total = providers.reduce((sum, [, rows]) => sum + rows.length, 0);
	return {
		robots: { status: 404, contentType: 'text/plain', body: 'not found' },
		filtersProviders: providers.map(([name]) => name),
		states: ['MD', 'VA'],
		totalN: total,
		totalPositions: String(total),
		scripts: new Map(),
		...over,
		providers
	};
}

function answer(w: World, url: string): Scripted {
	if (url === ROBOTS_URL) return w.robots;
	if (url === FILTERS_URL) {
		return json({
			providers: w.filtersProviders,
			states: w.states,
			industries: [],
			branches: [],
			meta: { totalPositions: w.totalPositions },
			dib: false
		});
	}
	const u = new URL(url);
	if (u.origin + u.pathname !== API_ORIGIN + LOOKUP_PATH) {
		return { status: 404, contentType: 'text/plain', body: 'no such page' };
	}
	const provider = u.searchParams.get('provider');
	const delivery = u.searchParams.get('deliveryMethod');
	const state = u.searchParams.get('state');
	const pool = (
		provider === null
			? w.providers.flatMap(([, rows]) => rows)
			: (w.providers.find(([name]) => name === provider) ?? ['', []])[1]
	).filter(
		(r) =>
			(delivery === null || r.deliveryMethodId === Number(delivery)) &&
			(state === null || r.state.includes(state))
	);
	return json({
		draw: 1,
		recordsTotal: provider === null && delivery === null && state === null ? w.totalN : pool.length,
		recordsFiltered: Math.min(pool.length, CAP),
		data: pool.slice(0, CAP)
	});
}

function fakeServer(w: World) {
	const calls: { url: string; at: number }[] = [];
	const sleeps: number[] = [];
	let t = START_MS;
	const clock: Clock = {
		now: () => t,
		sleep: (ms) => {
			sleeps.push(ms);
			t += ms;
			return Promise.resolve();
		}
	};
	const http: Http = (url) => {
		calls.push({ url, at: t });
		const reply = w.scripts.get(url)?.shift() ?? answer(w, url);
		return reply === 'reject'
			? Promise.reject(new Error('E_FAKE_NETWORK'))
			: Promise.resolve(reply);
	};
	return {
		http,
		clock,
		calls,
		sleeps,
		urls: () => calls.map((c) => c.url),
		advanced: () => t - START_MS
	};
}

function inputOf(over: Partial<PullInput> = {}): PullInput {
	return {
		mode: 'full',
		pullDate: '2026-10-19',
		publishedProviders: [],
		knownProviders: [],
		...over
	};
}

async function pull(w: World, input: Partial<PullInput> = {}) {
	const server = fakeServer(w);
	const outcome = await runPull(inputOf(input), server.http, server.clock);
	return { outcome, ...server };
}

function runOf(outcome: PullOutcome): PullRun {
	expect(outcome).toMatchObject({ ok: true });
	if (!outcome.ok) throw new Error('E_TEST_RUN_STOPPED');
	return outcome.run;
}

function providerUrl(name: string, suffix = ''): string {
	return `${ALL_URL}&provider=${encodeURIComponent(name)}${suffix}`;
}

const html = (body: string): HttpReply => ({ status: 200, contentType: 'text/html', body });
const status = (code: number): HttpReply => ({ status: code, contentType: 'text/plain', body: '' });

describe('lookupUrl', () => {
	it('builds the form the server answered to, spaces as %20 and parts in a fixed order', () => {
		expect(lookupUrl({})).toBe(ALL_URL);
		expect(lookupUrl({ provider: 'Example Co' })).toBe(`${ALL_URL}&provider=Example%20Co`);
		expect(lookupUrl({ provider: 'X', deliveryMethod: 2, state: 'MD' })).toBe(
			`${ALL_URL}&provider=X&deliveryMethod=2&state=MD`
		);
	});

	it.each(['@', '/', '#', '?', '&', '=', '..', 'a@evil.example/x#y?z&w=1/../..'])(
		'keeps a provider name holding %s inside the query, on the one host',
		(name) => {
			const url = lookupUrl({ provider: name });
			expect(url).toContain('provider=');
			const parsed = new URL(url);
			expect(parsed.host).toBe('api.skillbridge.mil');
			expect(parsed.protocol).toBe('https:');
			expect(parsed.pathname).toBe('/Location/Lookup');
			expect(parsed.hash).toBe('');
			expect(parsed.searchParams.get('provider')).toBe(name);
		}
	);
});

describe('robotsDisallows', () => {
	const OURS = 'ask214-skillbridge-finder';

	it.each([
		['everything is disallowed for everyone', 'User-agent: *\nDisallow: /', true],
		[
			'the section holding both endpoints is disallowed',
			'User-agent: *\nDisallow: /Location',
			true
		],
		['an unrelated path is disallowed', 'User-agent: *\nDisallow: /Other', false],
		['an empty Disallow disallows nothing', 'User-agent: *\nDisallow:', false],
		['an empty file says nothing', '', false],
		[
			'our own group allows while the * group disallows',
			`User-agent: *\nDisallow: /\n\nUser-agent: ${OURS}\nDisallow: /Other`,
			false
		],
		[
			'our own group disallows while the * group allows',
			`User-agent: *\nAllow: /\nUser-agent: ${OURS}\nDisallow: /`,
			true
		],
		[
			'our token is matched without regard to case',
			'User-agent: *\nAllow: /\nUSER-AGENT: ASK214-SkillBridge-Finder\nDISALLOW: /',
			true
		],
		[
			'two user-agent lines share the rules that follow them',
			`User-agent: other-bot\nUser-agent: ${OURS}\nDisallow: /`,
			true
		],
		[
			'a rule for another bot is not ours',
			'User-agent: other-bot\nDisallow: /\n\nUser-agent: *\nDisallow: /Other',
			false
		],
		[
			'the longer Allow beats the shorter Disallow for Lookup, but Filters stays disallowed',
			'User-agent: *\nAllow: /Location/Lookup\nDisallow: /Location',
			true
		],
		[
			'allowing both endpoints under a broad Disallow lets the pull go on',
			'User-agent: *\nDisallow: /Location\nAllow: /Location/Lookup\nAllow: /Location/Filters',
			false
		],
		[
			'the longer Disallow beats the shorter Allow, whatever the order',
			'User-agent: *\nAllow: /Location\nDisallow: /Location/Lookup',
			true
		],
		['an Allow wins a tie', 'User-agent: *\nDisallow: /Location\nAllow: /Location', false],
		['a comment and CRLF line ends are read', 'User-agent: *\r\nDisallow: / # keep out\r\n', true],
		['a commented-out rule is not a rule', 'User-agent: *\n# Disallow: /\n', false],
		['a wildcard rule matches in the middle', 'User-agent: *\nDisallow: /Loc*/Lookup', true],
		['a $ anchor matches the exact path', 'User-agent: *\nDisallow: /Location/Lookup$', true],
		['a $ anchor does not match a longer path', 'User-agent: *\nDisallow: /Location/Look$', false],
		[
			'a wildcard with a $ suffix only matches an ending',
			'User-agent: *\nDisallow: /*.json$',
			false
		],
		[
			'a wildcard with a $ suffix matches its ending',
			'User-agent: *\nDisallow: /Location/*up$',
			true
		],
		['rule paths are case sensitive', 'User-agent: *\nDisallow: /location', false]
	])('%s', (_name, robotsTxt, expected) => {
		expect(robotsDisallows(robotsTxt)).toBe(expected);
	});

	it('does not hang on a hostile rule with many wildcards', () => {
		const rule = `User-agent: *\nDisallow: /${'*a'.repeat(5000)}$`;
		const started = Date.now();
		expect(robotsDisallows(rule)).toBe(false);
		expect(Date.now() - started).toBeLessThan(2000);
	});
});

describe('runPull: robots.txt first', () => {
	it('stops on a Disallow before asking Filters or Lookup anything', async () => {
		const w = makeWorld({
			robots: { status: 200, contentType: 'text/plain', body: 'User-agent: *\nDisallow: /' }
		});
		const { outcome, urls } = await pull(w);
		expect(outcome).toEqual({ ok: false, stop: 'E_ROBOTS_DISALLOW', requests: 1, elapsedMs: 0 });
		expect(urls()).toEqual([ROBOTS_URL]);
	});

	it.each([
		['a 404', status(404)],
		['a 410', status(410)],
		[
			'a file that disallows something else',
			{ status: 200, contentType: 'text/plain', body: 'User-agent: *\nDisallow: /admin' }
		]
	])('goes on after %s', async (_name, robots) => {
		const { outcome, urls } = await pull(makeWorld({ robots }));
		expect(outcome.ok).toBe(true);
		expect(urls()[0]).toBe(ROBOTS_URL);
		expect(urls()[1]).toBe(FILTERS_URL);
	});

	it('stops when robots.txt comes back as a web page, which cannot be read as rules', async () => {
		const { outcome, urls } = await pull(makeWorld({ robots: html('<html>sign in</html>') }));
		expect(outcome).toMatchObject({ ok: false, stop: 'E_ROBOTS_UNREADABLE' });
		expect(urls()).toEqual([ROBOTS_URL]);
	});

	it('stops when robots.txt is served as text/html even though its body reads like rules', async () => {
		const robots = html('User-agent: *\nAllow: /');
		const { outcome, urls } = await pull(makeWorld({ robots }));
		expect(outcome).toMatchObject({ ok: false, stop: 'E_ROBOTS_UNREADABLE' });
		expect(urls()).toEqual([ROBOTS_URL]);
	});

	it('stops on a 403 for robots.txt like for any other request', async () => {
		const { outcome, urls } = await pull(makeWorld({ robots: status(403) }));
		expect(outcome).toMatchObject({ ok: false, stop: 'E_HTTP_403' });
		expect(urls()).toEqual([ROBOTS_URL]);
	});

	it('retries a failing robots.txt with backoff, as any other error', async () => {
		const w = makeWorld();
		w.scripts.set(ROBOTS_URL, [status(503), status(404)]);
		const { outcome, calls } = await pull(w);
		expect(outcome.ok).toBe(true);
		expect(calls.slice(0, 2).map((c) => c.url)).toEqual([ROBOTS_URL, ROBOTS_URL]);
	});
});

// RFC 9309 matches a rule against the path WITH the query, and every Lookup we send carries one, so a rule that
// forbids a query (`/*?`, `/*provider=`) must stop the pull even though the bare path is not forbidden.
describe('runPull: robots rules are tested against each request as sent', () => {
	const rules = (...lines: string[]): HttpReply => ({
		status: 200,
		contentType: 'text/plain',
		body: ['User-agent: *', ...lines].join('\n')
	});

	it.each([
		['any URL with a query', 'Disallow: /*?'],
		['the Lookup path with a query', 'Disallow: /Location/Lookup?'],
		['the Lookup path with the draw parameter', 'Disallow: /Location/Lookup?draw=1'],
		['a URL ending in the paging length', 'Disallow: /*length=150$']
	])(
		'stops before the first Lookup when robots.txt forbids %s, but Filters (no query) may go',
		async (_name, line) => {
			const { outcome, urls } = await pull(makeWorld({ robots: rules(line) }));
			expect(outcome).toEqual({
				ok: false,
				stop: 'E_ROBOTS_DISALLOW',
				requests: 2,
				elapsedMs: PAUSE_MS
			});
			expect(urls()).toEqual([ROBOTS_URL, FILTERS_URL]);
		}
	);

	it('stops before the first provider query, after the unfiltered Lookup, when robots.txt forbids provider=', async () => {
		const { outcome, urls } = await pull(makeWorld({ robots: rules('Disallow: /*provider=') }));
		expect(outcome).toMatchObject({ ok: false, stop: 'E_ROBOTS_DISALLOW', requests: 3 });
		expect(urls()).toEqual([ROBOTS_URL, FILTERS_URL, ALL_URL]);
	});

	it('lets the longest matching rule decide: a longer Allow beats a shorter Disallow on the query', async () => {
		// The provider URL matches "Allow /Location/Lookup?draw=1" (23 characters) and "Disallow /*provider=" (11).
		const robots = rules('Allow: /Location/Lookup?draw=1', 'Disallow: /*provider=');
		const { outcome, urls } = await pull(makeWorld({ robots }));
		expect(outcome.ok).toBe(true);
		expect(urls()).toContain(providerUrl('Acme Example'));
	});

	it('lets a longer Disallow on the query beat a shorter Allow on the path', async () => {
		const robots = rules(
			'Allow: /Location/Lookup',
			'Disallow: /Location/Lookup?draw=1&start=0&length=150&provider='
		);
		const { outcome, urls } = await pull(makeWorld({ robots }));
		expect(outcome).toMatchObject({ ok: false, stop: 'E_ROBOTS_DISALLOW', requests: 3 });
		expect(urls()).toEqual([ROBOTS_URL, FILTERS_URL, ALL_URL]);
	});

	it('still stops before Filters when robots.txt forbids the Filters path', async () => {
		const { outcome, urls } = await pull(
			makeWorld({ robots: rules('Disallow: /Location/Filters') })
		);
		expect(outcome).toEqual({ ok: false, stop: 'E_ROBOTS_DISALLOW', requests: 1, elapsedMs: 0 });
		expect(urls()).toEqual([ROBOTS_URL]);
	});

	it('does not stop for a rule on a query we never send', async () => {
		const { outcome } = await pull(makeWorld({ robots: rules('Disallow: /*?debug=') }));
		expect(outcome.ok).toBe(true);
	});

	it('applies the group for our own token to the queries too', async () => {
		const robots = {
			status: 200,
			contentType: 'text/plain',
			body: 'User-agent: *\nAllow: /\n\nUser-agent: ask214-skillbridge-finder\nDisallow: /*provider='
		};
		const { outcome } = await pull(makeWorld({ robots }));
		expect(outcome).toMatchObject({ ok: false, stop: 'E_ROBOTS_DISALLOW' });
	});
});

// RFC 9309 compares paths after normalising them: a non-ASCII character is the percent-encoding of its UTF-8
// octets, a %XX that stands for an unreserved character (A-Z a-z 0-9 - . _ ~) is that character, and the hex of
// every other %xx is upper case. A rule written in another spelling of the same path must still match.
describe('runPull: robots rules are compared in normal form', () => {
	const QUOTE = String.fromCharCode(0x2019);
	const rules = (line: string): HttpReply => ({
		status: 200,
		contentType: 'text/plain',
		body: `User-agent: *\n${line}`
	});
	const curly = `Curly${QUOTE}s Example`;
	const curlyWorld = (line: string) =>
		makeWorld({ robots: rules(line), providers: [[curly, rowsOf(1, 2)]] });

	it.each([
		['a raw U+2019', `Disallow: /*provider=Curly${QUOTE}s`],
		['its percent-encoding in capitals', 'Disallow: /*provider=Curly%E2%80%99s'],
		['its percent-encoding in lower case', 'Disallow: /*provider=Curly%e2%80%99s']
	])(
		'stops before the provider query when the rule spells the apostrophe as %s',
		async (_name, line) => {
			const { outcome, urls } = await pull(curlyWorld(line));
			expect(outcome).toMatchObject({ ok: false, stop: 'E_ROBOTS_DISALLOW', requests: 3 });
			expect(urls()).toEqual([ROBOTS_URL, FILTERS_URL, ALL_URL]);
		}
	);

	it('stops when the rule spells a letter of the provider name as a percent escape', async () => {
		const { outcome } = await pull(makeWorld({ robots: rules('Disallow: /*provider=%41cme') }));
		expect(outcome).toMatchObject({ ok: false, stop: 'E_ROBOTS_DISALLOW', requests: 3 });
	});

	it('stops before Filters when the rule spells a letter of the path as a percent escape', async () => {
		const { outcome, urls } = await pull(
			makeWorld({ robots: rules('Disallow: /%4Cocation/Lookup') })
		);
		expect(outcome).toEqual({ ok: false, stop: 'E_ROBOTS_DISALLOW', requests: 1, elapsedMs: 0 });
		expect(urls()).toEqual([ROBOTS_URL]);
	});

	it('reads the lower-case hex of an escaped letter the same way', () => {
		expect(robotsDisallows('User-agent: *\nDisallow: /%4cocation/Lookup')).toBe(true);
	});

	it('does not match a rule that differs in a real character', async () => {
		const { outcome } = await pull(makeWorld({ robots: rules('Disallow: /*provider=%41cmx') }));
		expect(outcome.ok).toBe(true);
	});

	it('keeps an escaped reserved character escaped, so it does not match the plain one', () => {
		expect(robotsDisallows('User-agent: *\nDisallow: /Location%2FLookup')).toBe(false);
		expect(robotsDisallows('User-agent: *\nDisallow: /Location%2flookup')).toBe(false);
	});
});

describe('runPull: stop on any sign of a "no"', () => {
	const cases: [string, HttpReply, string][] = [
		['a 403', status(403), 'E_HTTP_403'],
		['a 429', status(429), 'E_HTTP_429'],
		['a CAPTCHA page with a 200', html('<html>prove you are human</html>'), 'E_HTML_BODY'],
		[
			'a block page sent as JSON',
			{ status: 200, contentType: 'application/json', body: '\n <!DOCTYPE html><p>blocked</p>' },
			'E_HTML_BODY'
		],
		[
			'a 200 that is not JSON',
			{ status: 200, contentType: 'application/json', body: 'Service unavailable' },
			'E_NOT_JSON'
		],
		['a reply with no data', json({ recordsTotal: 3, recordsFiltered: 3 }), 'E_BAD_ENVELOPE'],
		[
			'rows that are not an array',
			json({ recordsTotal: 1, recordsFiltered: 1, data: 'x' }),
			'E_BAD_ENVELOPE'
		],
		[
			'a row without a numeric id',
			json({ recordsTotal: 1, recordsFiltered: 1, data: [{ id: '7' }] }),
			'E_BAD_ENVELOPE'
		],
		[
			'a row with id 0',
			json({ recordsTotal: 1, recordsFiltered: 1, data: [{ id: 0 }] }),
			'E_BAD_ENVELOPE'
		],
		[
			'a negative total',
			json({ recordsTotal: -1, recordsFiltered: 0, data: [] }),
			'E_BAD_ENVELOPE'
		],
		[
			'a fractional filtered count',
			json({ recordsTotal: 1, recordsFiltered: 0.5, data: [] }),
			'E_BAD_ENVELOPE'
		],
		[
			'a JSON null',
			{ status: 200, contentType: 'application/json', body: 'null' },
			'E_BAD_ENVELOPE'
		]
	];

	it.each(cases)('stops at once on %s and returns no rows', async (_name, reply, stop) => {
		const w = makeWorld();
		w.scripts.set(ALL_URL, [reply]);
		const { outcome, urls, advanced } = await pull(w);
		expect(outcome).toEqual({ ok: false, stop, requests: 3, elapsedMs: advanced() });
		expect(urls()).toEqual([ROBOTS_URL, FILTERS_URL, ALL_URL]);
	});

	it.each([
		['a total that is not a string', { meta: { totalPositions: 11978 } }],
		['a total with a comma in it', { meta: { totalPositions: '11,978' } }],
		['providers that are not all strings', { providers: ['Acme', 7] }],
		['no state list', { states: null }]
	])('stops on a Filters reply with %s', async (_name, broken) => {
		const w = makeWorld();
		w.scripts.set(FILTERS_URL, [
			json({
				providers: ['Acme Example'],
				states: ['MD'],
				industries: [],
				branches: [],
				meta: { totalPositions: '3' },
				...broken
			})
		]);
		const { outcome, urls } = await pull(w);
		expect(outcome).toMatchObject({ ok: false, stop: 'E_BAD_ENVELOPE' });
		expect(urls()).toEqual([ROBOTS_URL, FILTERS_URL]);
	});

	it('stops in the middle of the provider queries and sends nothing after the refused one', async () => {
		const w = makeWorld({
			providers: [
				['First Example', rowsOf(1, 2)],
				['Second Example', rowsOf(10, 2)],
				['Third Example', rowsOf(20, 2)]
			]
		});
		w.scripts.set(providerUrl('Second Example'), [status(429)]);
		const { outcome, urls } = await pull(w);
		expect(outcome).toMatchObject({ ok: false, stop: 'E_HTTP_429', requests: 5 });
		expect(urls().at(-1)).toBe(providerUrl('Second Example'));
		expect(urls()).not.toContain(providerUrl('Third Example'));
	});
});

// A block or CAPTCHA page often comes with an error status; asking again would be pushing against a "no".
describe('runPull: a web page sent with an error status', () => {
	const captcha = (code: number): HttpReply => ({
		status: code,
		contentType: 'text/html',
		body: '<html>captcha: prove you are human</html>'
	});

	it('stops at once on a 503 CAPTCHA page for Filters, without asking again', async () => {
		const w = makeWorld();
		w.scripts.set(FILTERS_URL, [captcha(503)]);
		const { outcome, urls } = await pull(w);
		expect(outcome).toMatchObject({ ok: false, stop: 'E_HTML_BODY', requests: 2 });
		expect(urls()).toEqual([ROBOTS_URL, FILTERS_URL]);
	});

	it('stops at once on a 401 page sent as JSON, since the body is a web page', async () => {
		const w = makeWorld();
		w.scripts.set(ALL_URL, [
			{ status: 401, contentType: 'application/json', body: ' <!DOCTYPE html><p>sign in</p>' }
		]);
		const { outcome, urls } = await pull(w);
		expect(outcome).toMatchObject({ ok: false, stop: 'E_HTML_BODY', requests: 3 });
		expect(urls()).toEqual([ROBOTS_URL, FILTERS_URL, ALL_URL]);
	});

	it('stops with E_ROBOTS_UNREADABLE on a 503 web page for robots.txt', async () => {
		const { outcome, urls } = await pull(makeWorld({ robots: captcha(503) }));
		expect(outcome).toMatchObject({ ok: false, stop: 'E_ROBOTS_UNREADABLE', requests: 1 });
		expect(urls()).toEqual([ROBOTS_URL]);
	});

	it('still reads a 404 web page for robots.txt as "no rules"', async () => {
		const { outcome } = await pull(makeWorld({ robots: captcha(404) }));
		expect(outcome.ok).toBe(true);
	});
});

describe('runPull: errors in a row', () => {
	it('stops on the third error in a row, after exactly three tries, waiting longer each time', async () => {
		const w = makeWorld();
		w.scripts.set(FILTERS_URL, [status(503), status(503), 'reject']);
		const { outcome, calls } = await pull(w);
		expect(outcome).toMatchObject({ ok: false, stop: 'E_ERRORS_IN_A_ROW', requests: 4 });
		expect(calls.map((c) => c.url)).toEqual([ROBOTS_URL, FILTERS_URL, FILTERS_URL, FILTERS_URL]);
		const starts = calls.slice(1).map((c) => c.at);
		expect([starts[1]! - starts[0]!, starts[2]! - starts[1]!]).toEqual([6_000, 12_000]);
	});

	it('goes on after two errors and a success, and the success clears the count', async () => {
		const w = makeWorld();
		w.scripts.set(FILTERS_URL, [status(503), status(500)]);
		w.scripts.set(ALL_URL, [status(502)]);
		const { outcome, urls } = await pull(w);
		expect(outcome.ok).toBe(true);
		expect(urls().filter((u) => u === FILTERS_URL)).toHaveLength(3);
		expect(urls().filter((u) => u === ALL_URL)).toHaveLength(2);
	});

	it('treats a 400 or a 404 from Lookup as an error to retry, not as a stop', async () => {
		const w = makeWorld();
		w.scripts.set(ALL_URL, [status(400), status(404)]);
		const { outcome, urls } = await pull(w);
		expect(outcome.ok).toBe(true);
		expect(urls().filter((u) => u === ALL_URL)).toHaveLength(3);
	});
});

describe('runPull: pacing', () => {
	it('starts every request at least 3 seconds after the previous one started, retries included', async () => {
		const w = makeWorld({
			providers: [
				['First Example', rowsOf(1, 2)],
				['Second Example', rowsOf(10, 2)]
			]
		});
		w.scripts.set(providerUrl('First Example'), [status(503)]);
		const { outcome, calls } = await pull(w);
		expect(outcome.ok).toBe(true);
		expect(calls.length).toBeGreaterThan(5);
		for (let i = 1; i < calls.length; i++) {
			expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(PAUSE_MS);
		}
	});

	it('does not make the first request wait', async () => {
		const { calls } = await pull(makeWorld());
		expect(calls[0]?.at).toBe(START_MS);
	});
});

describe('runPull: the name goes out as it came in', () => {
	const QUOTE = String.fromCharCode(0x2019);
	const names = [
		'Trailing Space Example ',
		'Comma, And & Amp Example',
		`Curly${QUOTE}s Example`,
		'Double  Space Example',
		'a@evil.example/x#y?z&w=1/../..'
	];

	it('sends each provider name through encodeURIComponent untouched and reports it byte for byte', async () => {
		const w = makeWorld({ providers: names.map((n, i) => [n, rowsOf(100 + i * 10, 2)]) });
		const { outcome, urls } = await pull(w);
		const run = runOf(outcome);
		for (const name of names) expect(urls()).toContain(providerUrl(name));
		expect(run.providers.map((p) => p.name)).toEqual(names);
		expect(run.providers.map((p) => p.total)).toEqual([2, 2, 2, 2, 2]);
	});

	it('only ever asks https://api.skillbridge.mil, whatever the names hold', async () => {
		const w = makeWorld({ providers: names.map((n, i) => [n, rowsOf(100 + i * 10, 2)]) });
		const { urls } = await pull(w);
		expect(urls().length).toBeGreaterThan(names.length);
		for (const url of urls()) {
			const parsed = new URL(url);
			expect(parsed.protocol).toBe('https:');
			expect(parsed.host).toBe('api.skillbridge.mil');
			expect(parsed.hash).toBe('');
		}
	});
});

describe('runPull: proving a provider was fully seen', () => {
	it('asks once for a provider small enough to fit under the cap, and calls it complete', async () => {
		const w = makeWorld({ providers: [['Small Example', rowsOf(1, 20)]] });
		const { outcome, urls } = await pull(w);
		expect(urls().filter((u) => u.includes('provider='))).toEqual([providerUrl('Small Example')]);
		expect(runOf(outcome).providers).toEqual([
			{
				name: 'Small Example',
				total: 20,
				ids: Array.from({ length: 20 }, (_, i) => i + 1),
				complete: true,
				cappedQueries: 0
			}
		]);
	});

	it('splits a provider past the cap by delivery method first, never by state', async () => {
		const rows = [
			...rowsOf(1, 100, { deliveryMethodId: 1 }),
			...rowsOf(101, 60, { deliveryMethodId: 2 }),
			...rowsOf(161, 40, { deliveryMethodId: 3 })
		];
		const w = makeWorld({ providers: [['Big Example', rows]] });
		const { outcome, urls } = await pull(w);
		const name = 'Big Example';
		expect(urls().slice(3)).toEqual([
			providerUrl(name),
			providerUrl(name, '&deliveryMethod=1'),
			providerUrl(name, '&deliveryMethod=2'),
			providerUrl(name, '&deliveryMethod=3'),
			providerUrl(name)
		]);
		const result = runOf(outcome).providers[0]!;
		expect(result.ids).toHaveLength(200);
		expect(result.complete).toBe(true);
		expect(result.cappedQueries).toBe(0);
	});

	it('splits a delivery method still past the cap by every state, only within that method', async () => {
		const rows = [
			...rowsOf(1, 80, { deliveryMethodId: 1, state: 'MD' }),
			...rowsOf(81, 80, { deliveryMethodId: 1, state: 'VA' }),
			...rowsOf(161, 30, { deliveryMethodId: 2, state: 'TX' }),
			...rowsOf(191, 10, { deliveryMethodId: 3, state: 'CA' })
		];
		const w = makeWorld({ providers: [['Big Example', rows]], states: ['MD', 'VA', 'TX', 'CA'] });
		const { outcome, urls } = await pull(w);
		const name = 'Big Example';
		expect(urls().slice(3)).toEqual([
			providerUrl(name),
			providerUrl(name, '&deliveryMethod=1'),
			providerUrl(name, '&deliveryMethod=1&state=MD'),
			providerUrl(name, '&deliveryMethod=1&state=VA'),
			providerUrl(name, '&deliveryMethod=1&state=TX'),
			providerUrl(name, '&deliveryMethod=1&state=CA'),
			providerUrl(name, '&deliveryMethod=2'),
			providerUrl(name, '&deliveryMethod=3'),
			providerUrl(name)
		]);
		const result = runOf(outcome).providers[0]!;
		expect(result.ids).toHaveLength(200);
		expect(result.complete).toBe(true);
	});

	it.each([
		['one listing no query can reach', 4, false],
		['every listing reachable', 3, true]
	])(
		'is complete only when unique ids reach the total: %s',
		async (_name, lastDelivery, complete) => {
			const rows = [
				...rowsOf(1, 150, { deliveryMethodId: 1, state: 'MD' }),
				...rowsOf(151, 49, { deliveryMethodId: 2, state: 'VA' }),
				...rowsOf(200, 1, { deliveryMethodId: lastDelivery, state: 'VA' })
			];
			const { outcome } = await pull(makeWorld({ providers: [['Big Example', rows]] }));
			const result = runOf(outcome).providers[0]!;
			expect(result.total).toBe(200);
			expect(result.ids).toHaveLength(complete ? 200 : 199);
			expect(result.complete).toBe(complete);
			expect(result.cappedQueries).toBe(1);
		}
	);

	// The server is live while the split runs. A listing added to the provider then can bring the count up to the
	// total read at the start while a listing the state queries cannot reach stays unseen, so the total is read
	// again after the split and must not have moved.
	it.each([
		['every listing reachable and nothing changes', 'CA', false, true],
		['one listing no state query reaches and nothing changes', 'NATIONWIDE', false, false],
		[
			'one listing no state query reaches and another is added during the split',
			'NATIONWIDE',
			true,
			false
		]
	])(
		'is complete only if the total held through the split: %s',
		async (_name, lastState, add, complete) => {
			const name = 'Big Example';
			const rows = [
				...rowsOf(1, 100, { deliveryMethodId: 1, state: 'CA' }),
				...rowsOf(101, 50, { deliveryMethodId: 1, state: 'VA' }),
				...rowsOf(151, 1, { deliveryMethodId: 1, state: lastState })
			];
			const w = makeWorld({ providers: [[name, rows]], states: ['CA', 'VA'] });
			const server = fakeServer(w);
			let added = false;
			const http: Http = async (url) => {
				const reply = await server.http(url);
				if (add && !added && url === providerUrl(name)) {
					added = true;
					w.providers[0]![1].push(...rowsOf(152, 1, { deliveryMethodId: 1, state: 'VA' }));
				}
				return reply;
			};
			const outcome = await runPull(inputOf(), http, server.clock);
			const result = runOf(outcome).providers[0]!;
			expect(result.total).toBe(151);
			expect(result.complete).toBe(complete);
			expect(server.urls().filter((u) => u === providerUrl(name))).toHaveLength(2);
		}
	);

	it('does not call a provider complete just because its reply fit under the cap', async () => {
		const w = makeWorld({ providers: [['Short Example', rowsOf(1, 40)]] });
		w.scripts.set(providerUrl('Short Example'), [
			json({ recordsTotal: 42, recordsFiltered: 40, data: rowsOf(1, 40) })
		]);
		const { outcome, urls } = await pull(w);
		const result = runOf(outcome).providers[0]!;
		expect(urls().filter((u) => u.includes('provider='))).toHaveLength(1);
		expect(result).toMatchObject({ total: 42, complete: false });
		expect(result.ids).toHaveLength(40);
	});

	it('stops splitting a provider the moment its unique ids reach its total', async () => {
		const rows = [
			...rowsOf(1, 80, { deliveryMethodId: 1, state: 'MD' }),
			...rowsOf(81, 80, { deliveryMethodId: 1, state: 'VA' })
		];
		const w = makeWorld({
			providers: [['Big Example', rows]],
			states: ['MD', 'VA', 'TX', 'CA']
		});
		const { outcome, urls } = await pull(w);
		const name = 'Big Example';
		expect(urls().slice(3)).toEqual([
			providerUrl(name),
			providerUrl(name, '&deliveryMethod=1'),
			providerUrl(name, '&deliveryMethod=1&state=MD'),
			providerUrl(name, '&deliveryMethod=1&state=VA'),
			providerUrl(name)
		]);
		expect(runOf(outcome).providers[0]).toMatchObject({ total: 160, complete: true });
	});

	it('treats a provider with no listings as complete with no ids, after one query', async () => {
		const w = makeWorld({
			providers: [
				['Empty Example', []],
				['Full Example', rowsOf(1, 2)]
			]
		});
		const { outcome, urls } = await pull(w);
		expect(runOf(outcome).providers[0]).toEqual({
			name: 'Empty Example',
			total: 0,
			ids: [],
			complete: true,
			cappedQueries: 0
		});
		expect(urls().filter((u) => u === providerUrl('Empty Example'))).toHaveLength(1);
	});

	it('returns each listing once, the first row seen, sorted by id, with each provider ids ascending', async () => {
		const rows = [
			...rowsOf(1, 100, { deliveryMethodId: 1, program: 'Original' }),
			...rowsOf(101, 60, { deliveryMethodId: 2 }),
			...rowsOf(161, 40, { deliveryMethodId: 3 })
		];
		const w = makeWorld({
			providers: [
				['Zed Example', rowsOf(500, 3).reverse()],
				['Big Example', rows]
			]
		});
		w.scripts.set(providerUrl('Big Example', '&deliveryMethod=1'), [
			json({
				recordsTotal: 100,
				recordsFiltered: 100,
				data: rowsOf(1, 100, { deliveryMethodId: 1, program: 'Changed Later' })
			})
		]);
		const { outcome } = await pull(w);
		const run = runOf(outcome);
		const ids = run.rows.map((r) => r.id);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(new Set(ids).size).toBe(203);
		expect(run.rows.find((r) => r.id === 1)?.program).toBe('Original');
		expect(run.providers[0]!.ids).toEqual([500, 501, 502]);
	});
});

describe('runPull: the sum gate', () => {
	const two = (): World =>
		makeWorld({
			providers: [
				['First Example', rowsOf(1, 4)],
				['Second Example', rowsOf(10, 6)]
			]
		});

	it('passes when every provider total adds up to the unfiltered count, and plans a weekly run', async () => {
		const { outcome } = await pull(two());
		const run = runOf(outcome);
		expect(run).toMatchObject({ totalN: 10, sumOfTotals: 10, sumGate: true, nextMode: 'weekly' });
	});

	it.each([
		['fewer', 11],
		['more', 9]
	])(
		'fails when the providers add up to %s than the whole, and plans a full run',
		async (_n, totalN) => {
			const { outcome } = await pull(makeWorld({ ...two(), totalN }), { mode: 'weekly' });
			const run = runOf(outcome);
			expect(run).toMatchObject({ totalN, sumOfTotals: 10, sumGate: false, nextMode: 'full' });
		}
	);
});

describe('runPull: which providers are asked', () => {
	const filtersWorld = (): World =>
		makeWorld({
			providers: [
				['Published Example', rowsOf(1, 3)],
				['Dormant Example', []],
				['Quiet Example', []],
				['New Example', rowsOf(10, 2)]
			]
		});
	const asked = (urls: string[]) =>
		urls.filter((u) => u.includes('provider=')).map((u) => new URL(u).searchParams.get('provider'));

	it('weekly: asks the published providers, then new ones, and leaves dormant ones when the sum reaches N', async () => {
		const { outcome, urls } = await pull(filtersWorld(), {
			mode: 'weekly',
			publishedProviders: ['Published Example', 'Published Example'],
			knownProviders: ['Published Example', 'Dormant Example', 'Quiet Example']
		});
		const run = runOf(outcome);
		expect(asked(urls())).toEqual(['Published Example', 'New Example']);
		expect(run).toMatchObject({ dormantSwept: false, sumOfTotals: 5, totalN: 5, sumGate: true });
	});

	it('weekly: sweeps the dormant providers when the sum falls short, and then recomputes', async () => {
		const w = makeWorld({
			providers: [
				['Published Example', rowsOf(1, 3)],
				['Dormant Example', rowsOf(20, 4)],
				['Quiet Example', []],
				['New Example', rowsOf(10, 2)]
			]
		});
		const { outcome, urls } = await pull(w, {
			mode: 'weekly',
			publishedProviders: ['Published Example'],
			knownProviders: ['Published Example', 'Dormant Example', 'Quiet Example']
		});
		const run = runOf(outcome);
		expect(asked(urls())).toEqual([
			'Published Example',
			'New Example',
			'Dormant Example',
			'Quiet Example'
		]);
		expect(run).toMatchObject({
			dormantSwept: true,
			sumOfTotals: 9,
			totalN: 9,
			sumGate: true,
			nextMode: 'weekly'
		});
		expect(run.providers.map((p) => p.name)).toEqual(asked(urls()));
	});

	it('weekly: still asks for a published provider that the Filters list no longer holds', async () => {
		const w = makeWorld({ providers: [['Listed Example', rowsOf(1, 2)]] });
		const { outcome, urls } = await pull(w, {
			mode: 'weekly',
			publishedProviders: ['Gone Example'],
			knownProviders: ['Listed Example']
		});
		expect(asked(urls())).toEqual(['Gone Example', 'Listed Example']);
		expect(runOf(outcome).dormantSwept).toBe(true);
	});

	it('full: asks every Filters provider in order, then published ones the list is missing', async () => {
		const { outcome, urls } = await pull(filtersWorld(), {
			mode: 'full',
			publishedProviders: ['New Example', 'Gone Example', 'Gone Example']
		});
		expect(asked(urls())).toEqual([
			'Published Example',
			'Dormant Example',
			'Quiet Example',
			'New Example',
			'Gone Example'
		]);
		expect(runOf(outcome).filtersProviders).toEqual([
			'Published Example',
			'Dormant Example',
			'Quiet Example',
			'New Example'
		]);
	});
});

describe('runPull: what the run reports', () => {
	it('reads totalPositions as a number, echoes mode and date, and counts every request', async () => {
		const w = makeWorld({ totalPositions: '11978' });
		w.scripts.set(providerUrl('Acme Example'), [status(503)]);
		const { outcome, urls, advanced } = await pull(w, { mode: 'full', pullDate: '2026-10-19' });
		const run = runOf(outcome);
		expect(run.totalPositions).toBe(11978);
		expect(run.mode).toBe('full');
		expect(run.pullDate).toBe('2026-10-19');
		expect(run.requests).toBe(urls().length);
		expect(urls()).toEqual([
			ROBOTS_URL,
			FILTERS_URL,
			ALL_URL,
			providerUrl('Acme Example'),
			providerUrl('Acme Example')
		]);
		expect(run.elapsedMs).toBe(advanced());
		expect(run.elapsedMs).toBeGreaterThan(0);
	});
});
