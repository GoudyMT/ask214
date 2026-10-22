/**
 * One validator for the published SkillBridge files, run by the weekly pipeline before anything is published
 * and by the app on every file it downloads. The listings are written by thousands of providers and arrive
 * through a server we do not control, so every field is treated as hostile: only known keys, allowlisted
 * values, capped lengths, and no markup or invisible characters. Returns opaque codes with the offending id and
 * field as data (never interpolated into a message), and collects every violation rather than stopping at one.
 */

import { isGovernmentHost } from '$lib/sources/government-host';
import {
	BRANCHES,
	CAPS,
	CONTRACT_VERSION,
	DELIVERY,
	DURATIONS,
	INDUSTRIES,
	KINDS,
	MAX_CHANGE_WEEKS,
	MAX_IDS,
	MAX_LISTINGS_PER_FILE
} from './listing';
import { REGION_FILE_NAMES, STATE_CODES, isIsoDate, isRegionFileName } from './places';

export type ContractError = { code: string; id?: number; field?: string };
export type ContractResult = { valid: boolean; errors: ContractError[] };

const REQUIRED = ['i', 'o', 'n', 'p', 'm', 'b', 'ind', 'dib', 'dc', 'fl'] as const;
const OPTIONAL = [
	'k',
	'c',
	's',
	'ls',
	'z',
	'la',
	'lo',
	'd',
	'r',
	'oc',
	'e',
	'u',
	'w',
	'li',
	'inst'
];
const LISTING_KEYS: ReadonlySet<string> = new Set([...REQUIRED, ...OPTIONAL]);

const KIND_SET: ReadonlySet<unknown> = new Set(KINDS);
const DURATION_SET: ReadonlySet<unknown> = new Set(DURATIONS);
const DELIVERY_SET: ReadonlySet<unknown> = new Set(Object.values(DELIVERY));
const BRANCH_SET: ReadonlySet<unknown> = new Set(BRANCHES);
const INDUSTRY_SET: ReadonlySet<unknown> = new Set(INDUSTRIES);
const STATE_SET: ReadonlySet<unknown> = new Set(STATE_CODES);

// Characters that render as nothing or are not text: control, format (zero-width, bidi), private-use and lone
// surrogate code points (with the u flag a surrogate outside a pair is its own code point); the ones Unicode marks
// default-ignorable (Hangul fillers, the grapheme joiner, variation selectors); and line and paragraph separators,
// which break a line inside a name. Unassigned code points are not refused: which ones are unassigned depends on the
// browser's Unicode version, so a character a newer Unicode added would drop a whole file on an older phone.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;
// A blank braille cell is neither default-ignorable nor a space, yet draws as empty.
const BRAILLE_BLANK = String.fromCharCode(0x2800);
const ZIP_RE = /^\d{5}$/;
const CODE_RE = /^[0-9A-Z]{2,6}$/;
// One plain address; no `?` so a mailto link built from it cannot carry a subject, body or second recipient.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const LINKEDIN_PATH_RE = /^\/company\/[A-Za-z0-9_%-]+\/?$/;
// A role list item with a colon or a dash is a sentence fragment ("Technician - Level 1"), not a role name.
const PROSE_MARKS = [':', '-', String.fromCharCode(0x2013), String.fromCharCode(0x2014)];

/**
 * Text that renders exactly as stored: not empty, no padding, already NFKC (no look-alike forms), nothing
 * invisible, and no `<` (a field holding markup is dropped by the pipeline, never escaped and shown).
 */
export function isSafeText(s: unknown): s is string {
	return (
		typeof s === 'string' &&
		s.length > 0 &&
		s === s.trim() &&
		s === s.normalize('NFKC') &&
		!INVISIBLE_RE.test(s) &&
		!s.includes(BRAILLE_BLANK) &&
		!s.includes('<')
	);
}

const isPositiveInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const isObject = (x: unknown): x is Record<string, unknown> =>
	typeof x === 'object' && x !== null && !Array.isArray(x);

function isEnumList(x: unknown, allowed: ReadonlySet<unknown>, min: number): boolean {
	return (
		Array.isArray(x) &&
		x.length >= min &&
		x.length <= allowed.size &&
		new Set(x).size === x.length &&
		x.every((v) => allowed.has(v))
	);
}

function parseHttps(s: unknown): URL | null {
	if (typeof s !== 'string' || s.length > CAPS.url || !isSafeText(s)) return null;
	try {
		const url = new URL(s);
		// A trailing dot names the same host ("army.mil.") but slips past a suffix check such as ".mil".
		return url.protocol === 'https:' &&
			url.username === '' &&
			url.password === '' &&
			!url.hostname.endsWith('.')
			? url
			: null;
	} catch {
		return null;
	}
}

function isRoleItem(s: string): boolean {
	const words = s.split(' ').filter((w) => w.length > 0);
	return (
		s.length <= CAPS.roleItem &&
		words.length <= CAPS.roleWords &&
		!PROSE_MARKS.some((m) => s.includes(m))
	);
}

/** Every rule a single listing must pass; an empty list means it may be published or shown. */
export function validateListing(raw: unknown): ContractError[] {
	if (!isObject(raw)) return [{ code: 'E_SBF_NOT_OBJECT' }];
	const errors: ContractError[] = [];
	const id = isPositiveInt(raw.i) ? raw.i : undefined;
	const fail = (code: string, field: string) =>
		errors.push(id === undefined ? { code, field } : { code, id, field });
	// JSON never carries `undefined`, so an undefined key is treated as absent.
	const has = (field: string) => raw[field] !== undefined;

	for (const key of Object.keys(raw))
		if (has(key) && !LISTING_KEYS.has(key)) fail('E_SBF_UNKNOWN_FIELD', key);
	for (const field of REQUIRED) if (!has(field)) fail('E_SBF_MISSING', field);

	for (const field of ['i', 'o'] as const)
		if (has(field) && !isPositiveInt(raw[field])) fail('E_SBF_BAD_ID', field);

	const text = (field: string, cap: number) => {
		if (!has(field)) return;
		if (!isSafeText(raw[field])) fail('E_SBF_BAD_TEXT', field);
		else if ((raw[field] as string).length > cap) fail('E_SBF_TOO_LONG', field);
	};
	text('n', CAPS.organization);
	text('p', CAPS.program);
	text('c', CAPS.city);
	text('inst', CAPS.installation);

	if (has('k') && !KIND_SET.has(raw.k)) fail('E_SBF_BAD_ENUM', 'k');
	if (has('d') && !DURATION_SET.has(raw.d)) fail('E_SBF_BAD_ENUM', 'd');
	if (has('m') && !DELIVERY_SET.has(raw.m)) fail('E_SBF_BAD_ENUM', 'm');
	if (has('s') && !STATE_SET.has(raw.s)) fail('E_SBF_BAD_ENUM', 's');
	if (has('ls') && !isEnumList(raw.ls, STATE_SET, 1)) fail('E_SBF_BAD_ENUM', 'ls');
	if (has('b') && !isEnumList(raw.b, BRANCH_SET, 0)) fail('E_SBF_BAD_ENUM', 'b');
	if (has('ind') && !isEnumList(raw.ind, INDUSTRY_SET, 0)) fail('E_SBF_BAD_ENUM', 'ind');
	if (has('dib') && typeof raw.dib !== 'boolean') fail('E_SBF_BAD_TYPE', 'dib');

	for (const field of ['dc', 'fl'] as const)
		if (has(field) && !isIsoDate(raw[field])) fail('E_SBF_BAD_DATE', field);
	if (has('z') && (typeof raw.z !== 'string' || !ZIP_RE.test(raw.z))) fail('E_SBF_BAD_ZIP', 'z');

	if (has('la') || has('lo')) {
		const la = raw.la;
		const lo = raw.lo;
		if (typeof la !== 'number' || !Number.isFinite(la) || Math.abs(la) > 90)
			fail('E_SBF_BAD_POINT', 'la');
		else if (typeof lo !== 'number' || !Number.isFinite(lo) || Math.abs(lo) > 180)
			fail('E_SBF_BAD_POINT', 'lo');
	}

	if (has('r')) {
		const r = raw.r;
		if (!Array.isArray(r)) fail('E_SBF_BAD_TYPE', 'r');
		else if (!r.every(isSafeText)) fail('E_SBF_BAD_TEXT', 'r');
		else if (r.length === 0 || r.length > CAPS.roles || !r.every(isRoleItem))
			fail('E_SBF_BAD_ROLES', 'r');
	}

	if (has('oc') && raw.oc !== 'all') {
		const oc = raw.oc;
		const ok =
			Array.isArray(oc) &&
			oc.length > 0 &&
			oc.length <= CAPS.codes &&
			oc.every((c) => typeof c === 'string' && CODE_RE.test(c)) &&
			new Set(oc).size === oc.length;
		if (!ok) fail('E_SBF_BAD_CODES', 'oc');
	}

	if (has('e')) {
		const e = raw.e;
		if (!isSafeText(e) || e.length > CAPS.email || !EMAIL_RE.test(e)) fail('E_SBF_BAD_EMAIL', 'e');
	}
	if (has('u') && parseHttps(raw.u) === null) fail('E_SBF_BAD_URL', 'u');
	if (has('e') && has('u')) fail('E_SBF_BOTH_CONTACTS', 'u');

	if (has('w')) {
		// A confirmed company site is shown as its home page only; a government host is never a company's site.
		const w = parseHttps(raw.w);
		if (
			w === null ||
			w.pathname !== '/' ||
			w.search !== '' ||
			w.hash !== '' ||
			isGovernmentHost(w.href)
		)
			fail('E_SBF_BAD_URL', 'w');
	}
	if (has('li')) {
		const li = parseHttps(raw.li);
		if (
			li === null ||
			li.hostname !== 'www.linkedin.com' ||
			!LINKEDIN_PATH_RE.test(li.pathname) ||
			li.search !== '' ||
			li.hash !== ''
		)
			fail('E_SBF_BAD_URL', 'li');
	}

	return errors;
}

function checkHeader(
	raw: Record<string, unknown>,
	keys: readonly string[],
	errors: ContractError[]
): void {
	for (const key of Object.keys(raw))
		if (!keys.includes(key)) errors.push({ code: 'E_SBF_UNKNOWN_FIELD', field: key });
	if (raw.v !== CONTRACT_VERSION) errors.push({ code: 'E_SBF_BAD_VERSION', field: 'v' });
	if (keys.includes('pullDate') && !isIsoDate(raw.pullDate))
		errors.push({ code: 'E_SBF_BAD_DATE', field: 'pullDate' });
}

const result = (errors: ContractError[]): ContractResult => ({
	valid: errors.length === 0,
	errors
});

/** One division or fixed file of listings. */
export function validateRegionFile(raw: unknown): ContractResult {
	if (!isObject(raw)) return result([{ code: 'E_SBF_NOT_OBJECT' }]);
	const errors: ContractError[] = [];
	checkHeader(raw, ['v', 'pullDate', 'file', 'listings'], errors);
	if (!isRegionFileName(raw.file)) errors.push({ code: 'E_SBF_BAD_FILE_NAME', field: 'file' });

	const listings = raw.listings;
	if (!Array.isArray(listings)) {
		errors.push({ code: 'E_SBF_BAD_TYPE', field: 'listings' });
		return result(errors);
	}
	// Checked before any row is read, so an oversized file costs nothing to refuse.
	if (listings.length > MAX_LISTINGS_PER_FILE)
		return result([...errors, { code: 'E_SBF_TOO_MANY_ROWS', field: 'listings' }]);

	const pullDate = isIsoDate(raw.pullDate) ? raw.pullDate : undefined;
	const seen = new Set<number>();
	for (const listing of listings) {
		errors.push(...validateListing(listing));
		const id = isObject(listing) && isPositiveInt(listing.i) ? listing.i : undefined;
		if (isObject(listing)) {
			// A listing cannot be first seen after the file was pulled, nor created after it was first seen.
			const { fl, dc } = listing;
			const late = (field: 'fl' | 'dc') =>
				errors.push(
					id === undefined
						? { code: 'E_SBF_BAD_DATE', field }
						: { code: 'E_SBF_BAD_DATE', id, field }
				);
			if (pullDate !== undefined && isIsoDate(fl) && fl > pullDate) late('fl');
			if (isIsoDate(fl) && isIsoDate(dc) && dc > fl) late('dc');
		}
		if (id === undefined) continue;
		if (seen.has(id)) errors.push({ code: 'E_SBF_DUP_ID', id, field: 'i' });
		seen.add(id);
	}
	return result(errors);
}

const isCount = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;

/** The file the app reads first: the current pull date and the files it may then ask for. */
export function validateIndex(raw: unknown): ContractResult {
	if (!isObject(raw)) return result([{ code: 'E_SBF_NOT_OBJECT' }]);
	const errors: ContractError[] = [];
	checkHeader(raw, ['v', 'pullDate', 'baseline', 'baselineDate', 'files'], errors);
	if (typeof raw.baseline !== 'boolean') errors.push({ code: 'E_SBF_BAD_TYPE', field: 'baseline' });

	const pullDate = raw.pullDate;
	const baselineDate = raw.baselineDate;
	// The baseline can only be this pull or an earlier one, and a baseline pull is its own baseline.
	if (
		!isIsoDate(baselineDate) ||
		(isIsoDate(pullDate) && baselineDate > pullDate) ||
		(raw.baseline === true && baselineDate !== pullDate)
	)
		errors.push({ code: 'E_SBF_BAD_DATE', field: 'baselineDate' });

	if (!Array.isArray(raw.files)) {
		errors.push({ code: 'E_SBF_BAD_TYPE', field: 'files' });
		return result(errors);
	}
	if (raw.files.length > REGION_FILE_NAMES.length)
		return result([...errors, { code: 'E_SBF_TOO_MANY_ROWS', field: 'files' }]);
	const names = new Set<string>();
	for (const entry of raw.files) {
		if (!isObject(entry) || !isRegionFileName(entry.name)) {
			errors.push({ code: 'E_SBF_BAD_FILE_NAME', field: 'files' });
			continue;
		}
		if (names.has(entry.name)) errors.push({ code: 'E_SBF_DUP_FILE', field: 'files' });
		names.add(entry.name);
		if (!isCount(entry.count) || !isCount(entry.bytes))
			errors.push({ code: 'E_SBF_BAD_COUNT', field: 'files' });
	}
	return result(errors);
}

/** Every current id with the pull date it was first listed, and the ids merged into another. */
export function validateIds(raw: unknown): ContractResult {
	if (!isObject(raw)) return result([{ code: 'E_SBF_NOT_OBJECT' }]);
	const errors: ContractError[] = [];
	checkHeader(raw, ['v', 'pullDate', 'ids', 'aliases'], errors);
	if (!Array.isArray(raw.ids) || !Array.isArray(raw.aliases)) {
		errors.push({ code: 'E_SBF_BAD_TYPE', field: 'ids' });
		return result(errors);
	}
	if (raw.ids.length > MAX_IDS || raw.aliases.length > MAX_IDS)
		return result([...errors, { code: 'E_SBF_TOO_MANY_ROWS', field: 'ids' }]);
	const pullDate = isIsoDate(raw.pullDate) ? raw.pullDate : undefined;

	const current = new Set<number>();
	for (const pair of raw.ids) {
		const [id, firstListed] = Array.isArray(pair) ? pair : [];
		if (!Array.isArray(pair) || pair.length !== 2 || !isPositiveInt(id)) {
			errors.push({ code: 'E_SBF_BAD_ID', field: 'ids' });
			continue;
		}
		if (!isIsoDate(firstListed) || (pullDate !== undefined && firstListed > pullDate))
			errors.push({ code: 'E_SBF_BAD_DATE', id, field: 'ids' });
		if (current.has(id)) errors.push({ code: 'E_SBF_DUP_ID', id, field: 'ids' });
		current.add(id);
	}
	// A merged id is no longer current, and it points at one that is.
	for (const pair of raw.aliases) {
		const [from, to] = Array.isArray(pair) ? pair : [];
		if (
			!Array.isArray(pair) ||
			pair.length !== 2 ||
			!isPositiveInt(from) ||
			!isPositiveInt(to) ||
			current.has(from) ||
			!current.has(to)
		)
			errors.push({ code: 'E_SBF_BAD_ALIAS', field: 'aliases' });
	}
	return result(errors);
}

/** Added and removed ids and new organizations for this week and last, newest first. */
export function validateChanges(raw: unknown): ContractResult {
	if (!isObject(raw)) return result([{ code: 'E_SBF_NOT_OBJECT' }]);
	const errors: ContractError[] = [];
	checkHeader(raw, ['v', 'weeks'], errors);
	const weeks = raw.weeks;
	if (!Array.isArray(weeks)) {
		errors.push({ code: 'E_SBF_BAD_TYPE', field: 'weeks' });
		return result(errors);
	}
	if (weeks.length > MAX_CHANGE_WEEKS)
		return result([...errors, { code: 'E_SBF_TOO_MANY_ROWS', field: 'weeks' }]);

	let previous: string | undefined;
	for (const week of weeks) {
		if (!isObject(week) || !isIsoDate(week.pullDate)) {
			errors.push({ code: 'E_SBF_BAD_DATE', field: 'weeks' });
			continue;
		}
		if (previous !== undefined && week.pullDate >= previous)
			errors.push({ code: 'E_SBF_BAD_ORDER', field: 'weeks' });
		previous = week.pullDate;
		for (const list of [week.added, week.removed, week.newOrgs])
			if (!Array.isArray(list) || list.length > MAX_IDS || !list.every(isPositiveInt))
				errors.push({ code: 'E_SBF_BAD_ID', field: 'weeks' });
	}
	return result(errors);
}
