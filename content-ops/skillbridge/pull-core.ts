/**
 * The weekly pull of the public SkillBridge listings, as pure logic: the network and the clock are injected, so a
 * test (or a dry run) never touches either. The server is not ours, so the pull is gentle (one request at a time,
 * paced, backing off), obeys robots.txt, and stops for good - publishing nothing - at the first sign the server
 * does not want it. It also proves, per provider, whether every listing was seen, so a later step never removes a
 * listing it merely failed to see.
 */

import type { ApiListing } from '../../src/lib/skillbridge-finder/contract/api.ts';
import {
	API_ORIGIN,
	BACKOFF_BASE_MS,
	DELIVERY_SPLIT,
	FILTERS_PATH,
	LOOKUP_CAP,
	LOOKUP_PATH,
	MAX_ERRORS_IN_A_ROW,
	PAUSE_MS,
	ROBOTS_PATH
} from './config.ts';
import type {
	LookupResponse,
	ProviderResult,
	PullInput,
	PullOutcome,
	PullRun,
	StopCode
} from './types.ts';

export type HttpReply = { status: number; contentType: string; body: string };
/** Resolves with the reply, or rejects on a network failure or timeout (that counts as an error). */
export type Http = (url: string) => Promise<HttpReply>;
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

/** Our crawler token in robots.txt; a group naming it replaces the `*` groups for us. */
const ROBOTS_TOKEN = 'ask214-skillbridge-finder';

/**
 * The Lookup URL for a query. Built by concatenation, not URLSearchParams (which turns a space into `+`, a form
 * encoding the server was not measured with), and the host is the constant: a provider name holding `@`, `/`, `#`,
 * `?`, `&`, `=` or `..` stays inside the encoded query. The name is never trimmed or normalized: the server
 * matches it byte for byte.
 */
export function lookupUrl(q: {
	provider?: string;
	deliveryMethod?: number;
	state?: string;
}): string {
	let url = `${API_ORIGIN}${LOOKUP_PATH}?draw=1&start=0&length=${LOOKUP_CAP}`;
	if (q.provider !== undefined) url += `&provider=${encodeURIComponent(q.provider)}`;
	if (q.deliveryMethod !== undefined) url += `&deliveryMethod=${q.deliveryMethod}`;
	if (q.state !== undefined) url += `&state=${encodeURIComponent(q.state)}`;
	return url;
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;

/**
 * The normal form robots.txt paths are compared in (RFC 9309 section 2.2.2): every non-ASCII character becomes
 * the percent-encoding of its UTF-8 octets, and a %XX that stands for an unreserved character becomes that
 * character. The hex of every other %xx is written upper case, since RFC 3986 treats the two cases as the same
 * octet. Applied to both the rule and the request, so two spellings of one path meet.
 */
function normalizeRobotsPath(path: string): string {
	let out = '';
	for (let i = 0; i < path.length;) {
		const char = String.fromCodePoint(path.codePointAt(i) ?? 0);
		i += char.length;
		if ((char.codePointAt(0) ?? 0) > 127) {
			for (const octet of new TextEncoder().encode(char))
				out += `%${octet.toString(16).toUpperCase().padStart(2, '0')}`;
		} else if (char === '%' && HEX_PAIR.test(path.slice(i, i + 2))) {
			const octet = parseInt(path.slice(i, i + 2), 16);
			i += 2;
			const decoded = String.fromCharCode(octet);
			out +=
				octet < 128 && UNRESERVED.test(decoded)
					? decoded
					: `%${octet.toString(16).toUpperCase().padStart(2, '0')}`;
		} else {
			out += char;
		}
	}
	return out;
}

export type RobotsRule = { allow: boolean; path: string };
type Group = { agents: string[]; rules: RobotsRule[] };

function parseRobots(text: string): Group[] {
	const groups: Group[] = [];
	let current: Group | null = null;
	const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	for (const raw of clean.split(/\r\n|\r|\n/)) {
		const hash = raw.indexOf('#');
		const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
		const colon = line.indexOf(':');
		if (colon === -1) continue;
		const field = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		if (field === 'user-agent') {
			// A user-agent line right after a rule starts a new group; right after another, it joins the group.
			if (current === null || current.rules.length > 0) {
				current = { agents: [], rules: [] };
				groups.push(current);
			}
			current.agents.push(value.toLowerCase());
		} else if (field === 'allow' || field === 'disallow') {
			current?.rules.push({ allow: field === 'allow', path: normalizeRobotsPath(value) });
		}
	}
	return groups;
}

/**
 * A robots.txt rule path against a request path: `*` is any run of characters, a trailing `$` pins the end,
 * otherwise the rule is a prefix. A small matcher on purpose: a RegExp built from rule text from a server we do not
 * control would be a way to hang the run.
 */
function ruleMatches(rule: string, path: string): boolean {
	const anchored = rule.endsWith('$');
	const [head = '', ...rest] = (anchored ? rule.slice(0, -1) : rule).split('*');
	if (!path.startsWith(head)) return false;
	if (rest.length === 0) return !anchored || path === head;
	let at = head.length;
	for (const [i, part] of rest.entries()) {
		if (i === rest.length - 1 && anchored) {
			return path.length - part.length >= at && path.endsWith(part);
		}
		const found = path.indexOf(part, at);
		if (found === -1) return false;
		at = found + part.length;
	}
	return true;
}

function pathDisallowed(rules: RobotsRule[], path: string): boolean {
	let best: RobotsRule | null = null;
	for (const rule of rules) {
		if (rule.path === '' || !ruleMatches(rule.path, path)) continue;
		const longer = best === null || rule.path.length > best.path.length;
		const tieForAllow =
			best !== null && rule.path.length === best.path.length && rule.allow && !best.allow;
		if (longer || tieForAllow) best = rule;
	}
	return best !== null && !best.allow;
}

/**
 * The rules of robots.txt (RFC 9309) that apply to us: the groups naming our token, or with none the `*` groups.
 * Parsed once; each request is then tested with `robotsAllows`.
 */
export function robotsRules(robotsTxt: string): RobotsRule[] {
	const groups = parseRobots(robotsTxt);
	const own = groups.filter((g) => g.agents.includes(ROBOTS_TOKEN));
	const applicable = own.length > 0 ? own : groups.filter((g) => g.agents.includes('*'));
	return applicable.flatMap((g) => g.rules);
}

/**
 * Whether the rules let us request `pathAndQuery`, which is the path plus the query exactly as sent (RFC 9309
 * matches the query too, and every Lookup carries one). The longest matching rule wins, Allow wins a tie, an empty
 * Disallow forbids nothing.
 */
export function robotsAllows(rules: RobotsRule[], pathAndQuery: string): boolean {
	return !pathDisallowed(rules, normalizeRobotsPath(pathAndQuery));
}

/** True when robots.txt forbids us either bare endpoint path; the pre-flight check before any query is built. */
export function robotsDisallows(robotsTxt: string): boolean {
	const rules = robotsRules(robotsTxt);
	return !robotsAllows(rules, LOOKUP_PATH) || !robotsAllows(rules, FILTERS_PATH);
}

/** Thrown inside the run to end it at once; `runPull` turns it into the outcome. */
class StopSignal extends Error {
	readonly stop: StopCode;
	constructor(stop: StopCode) {
		super(stop);
		this.stop = stop;
	}
}

function stopRun(stop: StopCode): never {
	throw new StopSignal(stop);
}

type Filters = { providers: string[]; states: string[]; totalPositions: number };

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
	return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function parseLookup(v: unknown): LookupResponse | null {
	if (!isRecord(v)) return null;
	const { recordsTotal, recordsFiltered, data } = v;
	if (!isCount(recordsTotal) || !isCount(recordsFiltered) || !Array.isArray(data)) return null;
	for (const row of data as unknown[]) {
		if (!isRecord(row) || !isCount(row['id']) || row['id'] < 1) return null;
	}
	return { recordsTotal, recordsFiltered, data: data as ApiListing[] };
}

function parseFilters(v: unknown): Filters | null {
	if (!isRecord(v)) return null;
	const { providers, states, meta } = v;
	if (!isStringArray(providers) || !isStringArray(states) || !isRecord(meta)) return null;
	const total = meta['totalPositions'];
	if (typeof total !== 'string' || !/^\d{1,15}$/.test(total)) return null;
	return { providers, states, totalPositions: Number(total) };
}

function looksLikeHtml(reply: HttpReply): boolean {
	return (
		reply.contentType.toLowerCase().includes('text/html') || reply.body.trimStart().startsWith('<')
	);
}

/** The one place a request is sent: pacing, error counting, backoff and the stop checks live here. */
function createSender(http: Http, clock: Clock) {
	let lastStart: number | null = null;
	let requests = 0;
	let errorsInARow = 0;
	let rules: RobotsRule[] = [];

	async function send(url: string, isRobots: boolean): Promise<HttpReply> {
		// Tested as sent, query included, and before the pacing wait: a forbidden request is never made.
		const target = new URL(url);
		if (!robotsAllows(rules, target.pathname + target.search)) stopRun('E_ROBOTS_DISALLOW');
		for (;;) {
			if (lastStart !== null) {
				const wait = lastStart + PAUSE_MS - clock.now();
				if (wait > 0) await clock.sleep(wait);
			}
			lastStart = clock.now();
			requests++;
			let reply: HttpReply | null;
			try {
				reply = await http(url);
			} catch {
				reply = null;
			}
			if (reply !== null) {
				if (reply.status === 403) stopRun('E_HTTP_403');
				if (reply.status === 429) stopRun('E_HTTP_429');
				const absentRobots = isRobots && (reply.status === 404 || reply.status === 410);
				const accepted = isRobots
					? reply.status === 200
					: reply.status >= 200 && reply.status <= 299;
				if (absentRobots || accepted) {
					errorsInARow = 0;
					return reply;
				}
				// A block or CAPTCHA page sent with an error status is a "no", not a hiccup: not asked again.
				if (looksLikeHtml(reply)) stopRun(isRobots ? 'E_ROBOTS_UNREADABLE' : 'E_HTML_BODY');
			}
			errorsInARow++;
			if (errorsInARow >= MAX_ERRORS_IN_A_ROW) stopRun('E_ERRORS_IN_A_ROW');
			await clock.sleep(BACKOFF_BASE_MS * 2 ** errorsInARow);
		}
	}

	async function getJson<T>(url: string, parse: (v: unknown) => T | null): Promise<T> {
		const reply = await send(url, false);
		if (looksLikeHtml(reply)) stopRun('E_HTML_BODY');
		let parsed: unknown;
		try {
			parsed = JSON.parse(reply.body);
		} catch {
			stopRun('E_NOT_JSON');
		}
		const value = parse(parsed);
		if (value === null) stopRun('E_BAD_ENVELOPE');
		return value;
	}

	return {
		send,
		getJson,
		requests: () => requests,
		/** Called once, with the rules read from robots.txt; every later request is tested against them. */
		obey: (parsed: RobotsRule[]) => {
			rules = parsed;
		}
	};
}

/** A reply that returned every row it counts, under the cap: nothing more can be hiding behind it. */
function isLeafComplete(reply: LookupResponse): boolean {
	return reply.data.length === reply.recordsFiltered && reply.recordsFiltered < LOOKUP_CAP;
}

/**
 * Pulls every listing, provider by provider. `provider` is a complete partition of the listings, so a provider whose
 * unique ids reach its `recordsTotal` is proven fully seen; one that does not is reported as not complete and a
 * later step keeps its listings rather than removing them.
 */
export async function runPull(input: PullInput, http: Http, clock: Clock): Promise<PullOutcome> {
	const startedAt = clock.now();
	const sender = createSender(http, clock);
	try {
		const run = await pullAll(input, sender, clock, startedAt);
		return { ok: true, run };
	} catch (e) {
		if (e instanceof StopSignal) {
			return {
				ok: false,
				stop: e.stop,
				requests: sender.requests(),
				elapsedMs: clock.now() - startedAt
			};
		}
		throw e;
	}
}

async function pullAll(
	input: PullInput,
	sender: ReturnType<typeof createSender>,
	clock: Clock,
	startedAt: number
): Promise<PullRun> {
	const robots = await sender.send(API_ORIGIN + ROBOTS_PATH, true);
	if (robots.status === 200) {
		if (looksLikeHtml(robots)) stopRun('E_ROBOTS_UNREADABLE');
		if (robotsDisallows(robots.body)) stopRun('E_ROBOTS_DISALLOW');
		sender.obey(robotsRules(robots.body));
	}

	const filters = await sender.getJson(API_ORIGIN + FILTERS_PATH, parseFilters);
	const totalN = (await sender.getJson(lookupUrl({}), parseLookup)).recordsTotal;

	const rowsById = new Map<number, ApiListing>();
	const results: ProviderResult[] = [];
	const queried = new Set<string>();

	async function queryProvider(name: string): Promise<void> {
		queried.add(name);
		const ids = new Set<number>();
		let cappedQueries = 0;
		const take = (reply: LookupResponse): LookupResponse => {
			for (const row of reply.data) {
				ids.add(row.id);
				if (!rowsById.has(row.id)) rowsById.set(row.id, row);
			}
			return reply;
		};

		const national = take(await sender.getJson(lookupUrl({ provider: name }), parseLookup));
		const total = national.recordsTotal;
		let totalHeld = true;
		if (!isLeafComplete(national)) {
			for (const deliveryMethod of DELIVERY_SPLIT) {
				if (ids.size >= total) break;
				const byDelivery = take(
					await sender.getJson(lookupUrl({ provider: name, deliveryMethod }), parseLookup)
				);
				if (isLeafComplete(byDelivery)) continue;
				for (const state of filters.states) {
					if (ids.size >= total) break;
					const byState = take(
						await sender.getJson(lookupUrl({ provider: name, deliveryMethod, state }), parseLookup)
					);
					if (!isLeafComplete(byState)) cappedQueries++;
				}
			}
			// The split takes many requests while the server stays live: a listing added meanwhile could make the
			// count while a listing the split cannot reach is still unseen. Only an unmoved total proves the count.
			const again = take(await sender.getJson(lookupUrl({ provider: name }), parseLookup));
			totalHeld = again.recordsTotal === total;
		}
		results.push({
			name,
			total,
			ids: [...ids].sort((a, b) => a - b),
			complete: totalHeld && ids.size >= total,
			cappedQueries
		});
	}

	const published = input.publishedProviders;
	const known = new Set(input.knownProviders);
	const order =
		input.mode === 'full'
			? [...filters.providers, ...published]
			: [...published, ...filters.providers.filter((p) => !known.has(p))];
	for (const name of new Set(order)) await queryProvider(name);

	const sumOf = () => results.reduce((sum, r) => sum + r.total, 0);
	let dormantSwept = false;
	if (input.mode === 'weekly' && sumOf() < totalN) {
		dormantSwept = true;
		for (const name of new Set(filters.providers)) {
			if (!queried.has(name)) await queryProvider(name);
		}
	}

	const sumOfTotals = sumOf();
	const sumGate = sumOfTotals === totalN;
	return {
		mode: input.mode,
		pullDate: input.pullDate,
		totalN,
		totalPositions: filters.totalPositions,
		filtersProviders: filters.providers,
		rows: [...rowsById.values()].sort((a, b) => a.id - b.id),
		providers: results,
		sumOfTotals,
		sumGate,
		dormantSwept,
		nextMode: sumGate ? 'weekly' : 'full',
		requests: sender.requests(),
		elapsedMs: clock.now() - startedAt
	};
}
