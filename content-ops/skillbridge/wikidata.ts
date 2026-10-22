/**
 * Wikidata (CC0) is asked, by exact English label, for an organization's official website and LinkedIn company id.
 * Names come from providers, so each is written into the query only as an escaped string literal, never as syntax.
 * A name Wikidata cannot pin down to one answer yields none: a wrong link is worse than no link.
 */

import {
	REQUEST_TIMEOUT_MS,
	USER_AGENT,
	WIKIDATA_BATCH,
	WIKIDATA_PAUSE_MS,
	WIKIDATA_SPARQL
} from './config.ts';
import type { WikidataFacts } from './links-core.ts';

const QUOTE = String.fromCharCode(34);
const BACKSLASH = String.fromCharCode(92);
const ESCAPES: ReadonlyMap<string, string> = new Map([
	[BACKSLASH, BACKSLASH + BACKSLASH],
	[QUOTE, BACKSLASH + QUOTE],
	[String.fromCharCode(10), BACKSLASH + 'n'],
	[String.fromCharCode(13), BACKSLASH + 'r'],
	[String.fromCharCode(9), BACKSLASH + 't']
]);
const MAX_ID_LENGTH = 200;

const isControl = (code: number): boolean => code < 0x20 || (code >= 0x7f && code <= 0x9f);

/** The name as an English-tagged SPARQL string literal, or null when it cannot be written safely. */
function literal(name: string): string | null {
	if (!name.isWellFormed()) return null;
	let out = '';
	for (const ch of name) {
		const escaped = ESCAPES.get(ch);
		if (escaped !== undefined) out += escaped;
		else if (isControl(ch.codePointAt(0) ?? 0)) return null;
		else out += ch;
	}
	return QUOTE + out + QUOTE + '@en';
}

/** The query for these names; a name that cannot be written as a safe literal is left out. */
export function sparqlFor(names: string[]): string {
	const literals = names.map(literal).filter((l): l is string => l !== null);
	return (
		'SELECT ?label ?site ?li WHERE { VALUES ?label { ' +
		literals.join(' ') +
		' } ?item rdfs:label ?label . ?item wdt:P31/wdt:P279* wd:Q43229 . ' +
		'OPTIONAL { ?item wdt:P856 ?site } OPTIONAL { ?item wdt:P4264 ?li } }'
	);
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
	typeof x === 'object' && x !== null && !Array.isArray(x);

function valueOf(binding: Record<string, unknown>, key: string): string | undefined {
	const cell = binding[key];
	return isRecord(cell) && typeof cell.value === 'string' ? cell.value : undefined;
}

const isHttps = (site: string): boolean => {
	try {
		return new URL(site).protocol === 'https:';
	} catch {
		return false;
	}
};

/** The single value, or undefined when there are none or several (several means the name is ambiguous). */
const only = (values: Set<string>): string | undefined =>
	values.size === 1 ? [...values][0] : undefined;

function readBatch(body: unknown, asked: ReadonlySet<string>): Map<string, WikidataFacts> {
	const found = new Map<string, { sites: Set<string>; ids: Set<string> }>();
	const results = isRecord(body) ? body.results : undefined;
	const bindings = isRecord(results) ? results.bindings : undefined;
	for (const binding of Array.isArray(bindings) ? bindings : []) {
		if (!isRecord(binding)) continue;
		const label = valueOf(binding, 'label');
		if (label === undefined || !asked.has(label)) continue;
		const entry = found.get(label) ?? { sites: new Set<string>(), ids: new Set<string>() };
		const site = valueOf(binding, 'site');
		if (site !== undefined) entry.sites.add(site);
		const id = valueOf(binding, 'li');
		if (id !== undefined && id.length > 0 && id.length <= MAX_ID_LENGTH) entry.ids.add(id);
		found.set(label, entry);
	}
	const facts = new Map<string, WikidataFacts>();
	for (const [label, entry] of found) {
		const site = only(entry.sites);
		const linkedinId = only(entry.ids);
		const kept: WikidataFacts = {
			...(site !== undefined && isHttps(site) ? { site } : {}),
			...(linkedinId === undefined ? {} : { linkedinId })
		};
		if (Object.keys(kept).length > 0) facts.set(label, kept);
	}
	return facts;
}

/** What Wikidata says about each name, in batches and gently; a batch that fails is skipped, not fatal. */
export async function queryWikidata(
	names: string[],
	deps: { fetch: typeof fetch; sleep(ms: number): Promise<void> }
): Promise<Map<string, WikidataFacts>> {
	const usable = [...new Set(names)].filter((name) => literal(name) !== null);
	const facts = new Map<string, WikidataFacts>();
	for (let start = 0; start < usable.length; start += WIKIDATA_BATCH) {
		if (start > 0) await deps.sleep(WIKIDATA_PAUSE_MS);
		const batch = usable.slice(start, start + WIKIDATA_BATCH);
		try {
			const response = await deps.fetch(
				WIKIDATA_SPARQL + '?query=' + encodeURIComponent(sparqlFor(batch)),
				{
					headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' },
					redirect: 'error',
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
				}
			);
			if (!response.ok) continue;
			for (const [label, found] of readBatch(await response.json(), new Set(batch)))
				facts.set(label, found);
		} catch {
			// A failed batch only means fewer links this week.
			continue;
		}
	}
	return facts;
}
