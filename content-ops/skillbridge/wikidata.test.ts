import { describe, expect, test } from 'vitest';
import { USER_AGENT, WIKIDATA_BATCH, WIKIDATA_PAUSE_MS, WIKIDATA_SPARQL } from './config.ts';
import { queryWikidata, sparqlFor } from './wikidata.ts';

const QUOTE = String.fromCharCode(34);
const BACKSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

type Binding = { label: string; site?: string; li?: string };

const reply = (bindings: Binding[]): Response =>
	new Response(
		JSON.stringify({
			results: {
				bindings: bindings.map((b) => ({
					label: { type: 'literal', value: b.label },
					...(b.site === undefined ? {} : { site: { type: 'uri', value: b.site } }),
					...(b.li === undefined ? {} : { li: { type: 'literal', value: b.li } })
				}))
			}
		}),
		{ status: 200 }
	);

/** A fetch that answers each call from `replies` in turn (an Error is thrown) and records what it was asked. */
function makeDeps(replies: (Response | Error)[], events: string[] = []) {
	const calls: { url: string; init: RequestInit }[] = [];
	const deps = {
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init: init ?? {} });
			events.push('fetch');
			const next = replies[calls.length - 1] ?? reply([]);
			if (next instanceof Error) throw next;
			return next;
		}) as typeof fetch,
		sleep: async (ms: number) => {
			events.push('sleep ' + ms);
		}
	};
	return { deps, calls };
}

const decoded = (url: string): string => new URL(url).searchParams.get('query') ?? '';
const namesIn = (query: string): number => query.split(QUOTE + '@en').length - 1;
const numbered = (count: number): string[] =>
	Array.from({ length: count }, (_, i) => 'Company ' + String(i).padStart(3, '0'));

describe('sparqlFor', () => {
	test('asks for organizations by exact English label, with the optional site and LinkedIn id', () => {
		expect(sparqlFor(['Example Wind Services', 'Other Co'])).toBe(
			'SELECT ?label ?site ?li WHERE { VALUES ?label { "Example Wind Services"@en "Other Co"@en } ' +
				'?item rdfs:label ?label . ?item wdt:P31/wdt:P279* wd:Q43229 . ' +
				'OPTIONAL { ?item wdt:P856 ?site } OPTIONAL { ?item wdt:P4264 ?li } }'
		);
	});

	test('a name that tries to close its string and add a clause stays inside its literal', () => {
		const hostile = 'Evil' + QUOTE + ' } ; DELETE';
		expect(sparqlFor([hostile])).toContain(
			'VALUES ?label { ' +
				QUOTE +
				'Evil' +
				BACKSLASH +
				QUOTE +
				' } ; DELETE' +
				QUOTE +
				'@en } ?item'
		);
		const query = sparqlFor([
			'Back' + BACKSLASH + 'slash',
			'Line' + LF + 'Break' + CR + 'Tab' + TAB
		]);
		expect(query).toContain(QUOTE + 'Back' + BACKSLASH + BACKSLASH + 'slash' + QUOTE + '@en');
		expect(query).toContain(
			QUOTE + 'Line' + BACKSLASH + 'nBreak' + BACKSLASH + 'rTab' + BACKSLASH + 't' + QUOTE + '@en'
		);
	});

	test('a name with any other control character, or a broken surrogate, is left out', () => {
		const query = sparqlFor([
			'Good',
			'Bell' + String.fromCharCode(7),
			'Delete' + String.fromCharCode(0x7f),
			'NextLine' + String.fromCharCode(0x85),
			'Lone' + String.fromCharCode(0xd800)
		]);
		expect(namesIn(query)).toBe(1);
		expect(query).toContain(QUOTE + 'Good' + QUOTE + '@en');
	});
});

describe('queryWikidata', () => {
	test('each request is a GET to the query service with the project agent, JSON accepted, no redirects', async () => {
		const { deps, calls } = makeDeps([reply([])]);
		await queryWikidata(['Example Wind Services'], deps);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.url.startsWith(WIKIDATA_SPARQL + '?query=')).toBe(true);
		expect(decoded(call?.url ?? '')).toBe(sparqlFor(['Example Wind Services']));
		expect(call?.init.headers).toEqual({
			'User-Agent': USER_AGENT,
			Accept: 'application/sparql-results+json'
		});
		expect(call?.init.redirect).toBe('error');
		expect(call?.init.method ?? 'GET').toBe('GET');
	});

	test('names go in batches with a pause between them, none before the first or after the last', async () => {
		const events: string[] = [];
		const { deps, calls } = makeDeps([], events);
		await queryWikidata(numbered(WIKIDATA_BATCH + 1), deps);
		expect(calls.map((c) => namesIn(decoded(c.url)))).toEqual([WIKIDATA_BATCH, 1]);
		expect(events).toEqual(['fetch', 'sleep ' + WIKIDATA_PAUSE_MS, 'fetch']);
	});

	test('a batch that fails, in any way, is skipped and the others still count', async () => {
		const { deps, calls } = makeDeps([
			new Response('busy', { status: 500 }),
			new Error('E_TEST_NETWORK'),
			new Response('<html>not json</html>', { status: 200 }),
			reply([
				{ label: 'Company 180', site: 'https://company180.test/', li: 'company-180' },
				{ label: 'Not Requested', site: 'https://other.test/' }
			])
		]);
		const facts = await queryWikidata(numbered(WIKIDATA_BATCH * 3 + 1), deps);
		expect(calls).toHaveLength(4);
		expect([...facts.entries()]).toEqual([
			['Company 180', { site: 'https://company180.test/', linkedinId: 'company-180' }]
		]);
	});

	test('two items with different sites give no site, and likewise for the LinkedIn id', async () => {
		const { deps } = makeDeps([
			reply([
				{ label: 'Name A', site: 'https://a1.test/', li: 'same-id' },
				{ label: 'Name A', site: 'https://a2.test/', li: 'same-id' },
				{ label: 'Name B', site: 'https://b.test/', li: 'b-one' },
				{ label: 'Name B', site: 'https://b.test/', li: 'b-two' },
				{ label: 'Name C', li: 'c-one' },
				{ label: 'Name C', li: 'c-two' }
			])
		]);
		const facts = await queryWikidata(['Name A', 'Name B', 'Name C'], deps);
		expect(facts.get('Name A')).toEqual({ linkedinId: 'same-id' });
		expect(facts.get('Name B')).toEqual({ site: 'https://b.test/' });
		expect(facts.has('Name C')).toBe(false);
	});

	test('only an https site is kept', async () => {
		const { deps } = makeDeps([
			reply([
				{ label: 'Name D', site: 'http://d.test/' },
				{ label: 'Name E', site: 'https://e.test/' },
				{ label: 'Name F', site: 'javascript:alert(1)' },
				{ label: 'Name G', site: 'not a url' }
			])
		]);
		const facts = await queryWikidata(['Name D', 'Name E', 'Name F', 'Name G'], deps);
		expect([...facts.entries()]).toEqual([['Name E', { site: 'https://e.test/' }]]);
	});
});
