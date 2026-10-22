/**
 * Cleans the raw SkillBridge rows to facts only. The rows are written by thousands of providers and arrive from a
 * server we do not control, so nothing is copied across: each published field is rebuilt from an allowlist (a
 * fixed set of values, a code-shaped token, a capped and scrubbed string), and anything that cannot be made safe
 * is dropped on its own or, when the row cannot stand without it, holds the whole row back under a static code.
 * Pure: the place tables are passed in, so no test or caller touches the network or the disk.
 */

import type { ApiListing } from '../../src/lib/skillbridge-finder/contract/api.ts';
import {
	BRANCHES,
	CAPS,
	DURATIONS,
	INDUSTRIES,
	type Branch,
	type Duration,
	type Industry,
	type Kind
} from '../../src/lib/skillbridge-finder/contract/listing.ts';
import {
	STATE_CODES,
	TERRITORY_CODES,
	isIsoDate,
	type StateCode
} from '../../src/lib/skillbridge-finder/contract/places.ts';
import { isSafeText, validateListing } from '../../src/lib/skillbridge-finder/contract/validate.ts';
import type { CleanListing, CleanOutput } from './types.ts';

export type Box = readonly [south: number, west: number, north: number, east: number];
export type PlaceLookups = {
	/** A state's padded box, or undefined when none is known (territories without one). */
	stateBox(code: StateCode): Box | undefined;
	/** A ZIP's centroid `[lat, lon]`, or undefined. */
	zipPoint(zip: string): readonly [number, number] | undefined;
};

const STATE_SET: ReadonlySet<string> = new Set(STATE_CODES);
const ALL_STATES: readonly StateCode[] = STATE_CODES.filter(
	(code) => !TERRITORY_CODES.includes(code)
);
const BRANCH_SET: ReadonlySet<string> = new Set(BRANCHES);
const DURATION_SET: ReadonlySet<string> = new Set(DURATIONS);
const INDUSTRY_ALIASES: readonly (readonly [string, Industry])[] = [
	['Education, Training, and Library', 'Educational Instruction and Library']
];

// Control, format (zero-width, bidi) and private-use characters: invisible, so they can hide or reorder text.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Co}]/gu;
const WHITESPACE_RE = /\s+/g;
const CODE_RE = /^[0-9A-Z]{2,6}$/;
// One plain address; no `?` so a mailto link built from it cannot carry a subject, body or second recipient.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
// A role with a colon or a dash is a sentence fragment, not a role name.
const PROSE_MARKS = [':', '-', String.fromCharCode(0x2013), String.fromCharCode(0x2014)];

/** The validator wants a first-listed date; the real one is set by a later step, so any real date will do here. */
const PLACEHOLDER_FIRST_LISTED = '2000-01-01';

type Raw = Readonly<Record<string, unknown>>;
type Cleaned = { listing: CleanListing; overseas: boolean; drops: string[] };
type Held = { held: true; id: number; code: string };

// Hangul fillers and the braille blank are letters or symbols to Unicode but draw as empty space, so a name made
// of them would pass as text while showing nothing.
const BLANK_LOOKING = new Set(
	[0x115f, 0x1160, 0x2800, 0x3164, 0xffa0].map((code) => String.fromCharCode(code))
);

function withoutBlankLooking(text: string): string {
	let out = '';
	for (const char of text) if (!BLANK_LOOKING.has(char)) out += char;
	return out;
}

/**
 * NFKC, no invisible characters, whitespace runs as one space, trimmed; empty when nothing is left or the value
 * is not a string. Whitespace is collapsed before the strip too, because a tab or newline is a control
 * character and stripping it first would glue the words on either side of it together.
 */
function scrub(value: unknown): string {
	if (typeof value !== 'string') return '';
	return withoutBlankLooking(
		value.normalize('NFKC').replace(WHITESPACE_RE, ' ').replace(INVISIBLE_RE, '')
	)
		.replace(WHITESPACE_RE, ' ')
		.trim()
		.normalize('NFKC');
}

const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
// More than two combining marks in a row is stacked "zalgo" text that draws over the lines around it.
const STACKED_MARKS_RE = /\p{M}{3,}/u;

/** True for text worth publishing: shows a letter or digit, no markup, no stacked marks. */
function isPlainText(text: string): boolean {
	return LETTER_OR_DIGIT_RE.test(text) && !text.includes('<') && !STACKED_MARKS_RE.test(text);
}

/** Scrubbed text that may be published within its cap, or undefined (empty, markup, stacked marks, too long). */
function capped(text: string, cap: number): string | undefined {
	return isPlainText(text) && text.length <= cap ? text : undefined;
}

const isId = (value: unknown): value is number =>
	Number.isSafeInteger(value) && (value as number) > 0;

function cleanState(value: unknown, drops: string[]): { state?: StateCode; overseas: boolean } {
	const text = typeof value === 'string' ? value.trim() : '';
	if (STATE_SET.has(text)) return { state: text as StateCode, overseas: false };
	if (text === 'OS') return { overseas: true };
	// "Virtual" says nothing the delivery method does not; every other value is unusable and counted.
	if (text !== '' && text !== 'Virtual') drops.push('D_STATE');
	return { overseas: false };
}

function cleanStates(value: unknown, state: StateCode | undefined): StateCode[] | undefined {
	const text = typeof value === 'string' ? value : '';
	if (text.trim().toUpperCase() === 'ALL') return [...ALL_STATES];
	// Whole, exactly-cased tokens only: prose such as "in Maryland or Virginia" holds words that spell codes.
	const named = new Set(text.split(/[,;\s]+/).filter((token) => STATE_SET.has(token)));
	const states = STATE_CODES.filter((code) => named.has(code));
	if (states.length > 0) return states;
	return state === undefined ? undefined : [state];
}

function cleanZip(value: unknown, drops: string[]): string | undefined {
	const text = typeof value === 'string' ? value.trim() : '';
	if (/^\d{5}$/.test(text)) return text;
	// A spreadsheet dropped the leading zero.
	if (/^\d{4}$/.test(text)) return '0' + text;
	if (/^\d{5}-\d{4}$/.test(text) || /^\d{9}$/.test(text)) return text.slice(0, 5);
	if (text !== '') drops.push('D_ZIP');
	return undefined;
}

function insideBox(lat: number, lon: number, box: Box): boolean {
	const [south, west, north, east] = box;
	return lat >= south && lat <= north && lon >= west && lon <= east;
}

function cleanPoint(
	row: Raw,
	state: StateCode | undefined,
	zip: string | undefined,
	places: PlaceLookups,
	drops: string[]
): readonly [number, number] | undefined {
	const { lat, lon } = row;
	const given = typeof lat === 'number' && typeof lon === 'number';
	if (
		given &&
		Number.isFinite(lat) &&
		Number.isFinite(lon) &&
		!(lat === 0 && lon === 0) &&
		Math.abs(lat) <= 90 &&
		Math.abs(lon) <= 180 &&
		state !== undefined
	) {
		const box = places.stateBox(state);
		if (box !== undefined && insideBox(lat, lon, box)) return [lat, lon];
	}
	const centroid = zip === undefined ? undefined : places.zipPoint(zip);
	if (centroid !== undefined) {
		drops.push('P_ZIP_CENTROID');
		return centroid;
	}
	if (given) drops.push('D_POINT');
	return undefined;
}

function cleanDuration(value: unknown, drops: string[]): Duration | undefined {
	const text = scrub(value);
	if (text === '') return undefined;
	if (text === 'More than 180 days') return '180+';
	const match = /^(\d+) - (\d+) days$/.exec(text);
	const bucket = match === null ? '' : `${match[1]}-${match[2]}`;
	if (DURATION_SET.has(bucket)) return bucket as Duration;
	drops.push('D_DURATION');
	return undefined;
}

function cleanBranches(value: unknown, drops: string[]): Branch[] {
	const listed = Array.isArray(value) ? (value as unknown[]) : [];
	if (listed.some((branch) => typeof branch !== 'string' || !BRANCH_SET.has(branch)))
		drops.push('D_BRANCH');
	return BRANCHES.filter((branch) => listed.includes(branch));
}

// Each family with how to find its earliest mention; the earliest in the text wins.
const KIND_FAMILIES: readonly (readonly [Kind, (text: string) => number])[] = [
	// Whole words: "intern" opens "international" and "internet", "fellow" opens "fellowship" only as a word.
	['internship', (t) => t.search(/\bintern(?:s|ship|ships)?\b/)],
	['apprenticeship', (t) => t.search(/\bapprentic/)],
	['fellowship', (t) => t.search(/\bfellow(?:s|ship|ships)?\b/)],
	[
		'job-training',
		(t) =>
			[
				t.indexOf('job training'),
				t.indexOf('on-the-job'),
				t.indexOf('on the job'),
				t.search(/\bojt\b/),
				t.indexOf('train to hire'),
				t.indexOf('training with follow on employment')
			]
				.filter((at) => at >= 0)
				.reduce((a, b) => Math.min(a, b), Infinity)
	],
	[
		'skills-training',
		(t) =>
			[t.indexOf('skills training'), t.indexOf('skill training'), t.indexOf('skills program')]
				.filter((at) => at >= 0)
				.reduce((a, b) => Math.min(a, b), Infinity)
	]
];

function cleanKind(value: unknown, drops: string[]): Kind | undefined {
	const text = scrub(value).toLowerCase();
	if (text === '') return undefined;
	let best: Kind | undefined;
	let bestAt = Infinity;
	for (const [kind, find] of KIND_FAMILIES) {
		const at = find(text);
		if (at >= 0 && at < bestAt) {
			best = kind;
			bestAt = at;
		}
	}
	if (best === undefined) drops.push('D_KIND');
	return best;
}

/** Splits on commas that sit outside parentheses; undefined when the parentheses do not balance. */
function splitOutsideParentheses(text: string): string[] | undefined {
	const items: string[] = [];
	let depth = 0;
	let start = 0;
	for (let at = 0; at < text.length; at++) {
		const char = text[at];
		if (char === '(') depth++;
		else if (char === ')') depth--;
		if (depth < 0) return undefined;
		if (char === ',' && depth === 0) {
			items.push(text.slice(start, at));
			start = at + 1;
		}
	}
	if (depth !== 0) return undefined;
	items.push(text.slice(start));
	return items;
}

function isRole(item: string): boolean {
	return (
		isSafeText(item) &&
		isPlainText(item) &&
		item.length <= CAPS.roleItem &&
		item.split(' ').length <= CAPS.roleWords &&
		!PROSE_MARKS.some((mark) => item.includes(mark))
	);
}

function cleanRoles(value: unknown, drops: string[]): string[] | undefined {
	const whole = scrub(value);
	if (whole === '') return undefined;
	const split = splitOutsideParentheses(whole);
	const items = (split ?? []).map(scrub).filter((item) => item !== '');
	if (split !== undefined && items.length >= 1 && items.length <= CAPS.roles && items.every(isRole))
		return items;
	drops.push('D_ROLES');
	return undefined;
}

const NAME_START = [' ', ','];
const NAME_END = [' ', ',', ';'];

/** True when `name` occurs in `text` set off by a start, a space or a comma before and an end, space, comma or `;` after. */
function hasName(text: string, name: string): boolean {
	for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
		const before = at === 0 ? ' ' : (text[at - 1] ?? '');
		const after = at + name.length >= text.length ? ' ' : (text[at + name.length] ?? '');
		if (NAME_START.includes(before) && NAME_END.includes(after)) return true;
	}
	return false;
}

function cleanIndustries(value: unknown, drops: string[]): Industry[] {
	const found = new Set<Industry>();
	for (const segment of scrub(value).split(';')) {
		let rest = segment;
		const cut = [rest.indexOf('Other -'), rest.indexOf('Other-')]
			.filter((at) => at >= 0)
			.reduce((a, b) => Math.min(a, b), Infinity);
		if (cut !== Infinity) rest = rest.slice(0, cut);
		const bare = rest.replace(/\bOther\b/g, '');
		if (cut !== Infinity || bare !== rest) drops.push('D_INDUSTRY_OTHER');
		rest = bare;
		let named = false;
		for (const name of INDUSTRIES) {
			if (hasName(rest, name)) {
				found.add(name);
				named = true;
			}
		}
		for (const [alias, name] of INDUSTRY_ALIASES) {
			if (hasName(rest, alias)) {
				found.add(name);
				named = true;
			}
		}
		if (!named && rest.trim() !== '') drops.push('D_INDUSTRY_UNKNOWN');
	}
	return INDUSTRIES.filter((name) => found.has(name));
}

function cleanCodes(value: unknown, drops: string[]): string[] | 'all' | undefined {
	const text = scrub(value);
	if (text === '') return undefined;
	if (/^all\b/i.test(text)) return 'all';
	let stripped = text;
	for (let before = ''; before !== stripped;) {
		before = stripped;
		stripped = stripped.replace(/\([^()]*\)/g, ' ');
	}
	const pieces = stripped
		.split(/[,;]/)
		.flatMap((item) => item.split(/\s+/))
		.filter((p) => p !== '');
	const codes = [...new Set(pieces)];
	if (codes.length > 0 && codes.length <= CAPS.codes && pieces.every((p) => CODE_RE.test(p)))
		return codes;
	drops.push('D_CODES');
	return undefined;
}

function httpsLink(piece: string): string | undefined {
	if (piece.length > CAPS.url || !isSafeText(piece)) return undefined;
	try {
		const url = new URL(piece);
		const ok =
			url.protocol === 'https:' &&
			url.username === '' &&
			url.password === '' &&
			// A trailing dot names the same host but slips past a suffix check.
			!url.hostname.endsWith('.');
		return ok ? piece : undefined;
	} catch {
		return undefined;
	}
}

function cleanContact(
	value: unknown,
	suppression: ReadonlySet<string>,
	drops: string[]
): { e?: string; u?: string } {
	if (typeof value !== 'string') return {};
	const text = value
		.normalize('NFKC')
		.replace(/\s*@\s*/g, '@')
		.trim();
	if (text === '') return {};
	const lower = text.toLowerCase();
	if (lower.startsWith('http://') || lower.startsWith('https://')) {
		const link = lower.startsWith('https://') ? httpsLink(text.split(/\s+/)[0] ?? '') : undefined;
		if (link === undefined) {
			drops.push('D_EMAIL');
			return {};
		}
		return { u: link };
	}
	const address = text
		.split(/[;,\s]+/)
		.find((piece) => piece.length <= CAPS.email && EMAIL_RE.test(piece));
	if (address === undefined) {
		drops.push('D_EMAIL');
		return {};
	}
	if (suppression.has(address.toLowerCase())) {
		drops.push('D_SUPPRESSED');
		return {};
	}
	return { e: address };
}

function hold(row: unknown, code: string): Held {
	const id = typeof row === 'object' && row !== null ? (row as Raw).id : undefined;
	return { held: true, id: isId(id) ? id : 0, code };
}

function cleanRow(
	input: unknown,
	options: { suppression: ReadonlySet<string>; places: PlaceLookups }
): Cleaned | Held {
	if (typeof input !== 'object' || input === null) return hold(input, 'E_Q_ID');
	const row = input as Raw;
	const drops: string[] = [];

	const { id, organizationId } = row;
	if (!isId(id) || !isId(organizationId)) return hold(row, 'E_Q_ID');
	const n = capped(scrub(row.organization), CAPS.organization);
	if (n === undefined) return hold(row, 'E_Q_NAME');
	const p = capped(scrub(row.program), CAPS.program);
	if (p === undefined) return hold(row, 'E_Q_PROGRAM');
	const m = row.deliveryMethodId;
	if (m !== 1 && m !== 2 && m !== 3) return hold(row, 'E_Q_DELIVERY');
	const created = typeof row.dateCreated === 'string' ? row.dateCreated.slice(0, 10) : '';
	if (!isIsoDate(created)) return hold(row, 'E_Q_DATE');
	const dib = row.dib;
	if (typeof dib !== 'boolean') return hold(row, 'E_Q_DIB');

	const { state, overseas } = cleanState(row.state, drops);
	const zip = cleanZip(row.zip, drops);
	const listing: CleanListing = {
		i: id,
		o: organizationId,
		n,
		p,
		m,
		b: cleanBranches(row.branches, drops),
		ind: cleanIndustries(row.industries, drops),
		dib,
		dc: created
	};
	const kind = cleanKind(row.programType, drops);
	if (kind !== undefined) listing.k = kind;
	const city = scrub(row.city);
	if (city !== '') {
		const kept = capped(city, CAPS.city);
		if (kept === undefined) drops.push('D_CITY');
		else listing.c = kept;
	}
	if (state !== undefined) listing.s = state;
	const states = cleanStates(row.locationStates, state);
	if (states !== undefined) listing.ls = states;
	if (zip !== undefined) listing.z = zip;
	const point = cleanPoint(row, state, zip, options.places, drops);
	if (point !== undefined) [listing.la, listing.lo] = point;
	const duration = cleanDuration(row.duration, drops);
	if (duration !== undefined) listing.d = duration;
	const roles = cleanRoles(row.jobDescription, drops);
	if (roles !== undefined) listing.r = roles;
	const codes = cleanCodes(row.targetMOCs, drops);
	if (codes !== undefined) listing.oc = codes;
	const contact = cleanContact(row.employerPocEmail, options.suppression, drops);
	if (contact.e !== undefined) listing.e = contact.e;
	if (contact.u !== undefined) listing.u = contact.u;
	const installation = scrub(row.installation);
	if (installation !== '') {
		const kept = capped(installation, CAPS.installation);
		if (kept === undefined) drops.push('D_INSTALLATION');
		else listing.inst = kept;
	}

	// The last net: whatever the rules above let through must still pass the validator the app will run.
	if (validateListing({ ...listing, fl: PLACEHOLDER_FIRST_LISTED }).length > 0)
		return hold(row, 'E_Q_INVALID');
	return { listing, overseas, drops };
}

/** Everything but the id, in a fixed order, so two rows with the same facts get the same key. */
function contentKey(entry: Cleaned): string {
	const l = entry.listing;
	return JSON.stringify([
		l.o,
		l.n,
		l.p,
		l.k,
		l.c,
		l.s,
		l.ls,
		l.z,
		l.la,
		l.lo,
		l.d,
		l.m,
		l.b,
		l.r,
		l.ind,
		l.oc,
		l.dib,
		l.dc,
		l.e,
		l.u,
		l.inst,
		// An overseas listing and one with an unusable state both lack `s`, but they are published apart.
		entry.overseas
	]);
}

export function cleanListings(
	raw: readonly ApiListing[],
	options: { suppression: ReadonlySet<string>; places: PlaceLookups }
): CleanOutput {
	const quarantine: CleanOutput['quarantine'] = [];
	const dropped: Record<string, number> = {};
	const cleaned: Cleaned[] = [];
	for (const row of raw) {
		const result = cleanRow(row, options);
		if ('held' in result) {
			quarantine.push({ id: result.id, code: result.code });
			continue;
		}
		cleaned.push(result);
		for (const code of result.drops) dropped[code] = (dropped[code] ?? 0) + 1;
	}

	cleaned.sort((a, b) => a.listing.i - b.listing.i);
	const kept = new Map<string, Cleaned>();
	const aliases: CleanOutput['aliases'] = [];
	for (const entry of cleaned) {
		const key = contentKey(entry);
		const first = kept.get(key);
		if (first === undefined) kept.set(key, entry);
		else if (first.listing.i !== entry.listing.i) aliases.push([entry.listing.i, first.listing.i]);
	}
	const published = [...kept.values()].sort((a, b) => a.listing.i - b.listing.i);

	quarantine.sort((a, b) => a.id - b.id);
	return {
		listings: published.map((entry) => entry.listing),
		aliases,
		quarantine,
		dropped,
		overseas: published.filter((entry) => entry.overseas).map((entry) => entry.listing.i)
	};
}
