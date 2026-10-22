/**
 * Builds the SkillBridge finder's supporting tables from four public datasets: the Census ZIP code tabulation
 * area gazetteer (ZIP points), the Census ZCTA-to-county relationship file (each ZIP's state), the Census counties
 * gazetteer (the state boxes and the state of each county) and the O*NET Military Crosswalk (military job codes
 * to civilian occupations). Each reader refuses a line it does not understand by throwing a
 * static code, because a table built on a guess would quietly serve wrong distances or wrong job matches.
 * Pure: the text is passed in, so no test touches the disk or the network.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { Branch } from '../../src/lib/skillbridge-finder/contract/listing.ts';
import { STATE_CODES, type StateCode } from '../../src/lib/skillbridge-finder/contract/places.ts';
import {
	validateCrosswalk,
	validateZips,
	type CrosswalkTable,
	type ZipsTable
} from '../../src/lib/skillbridge-finder/contract/tables.ts';
import { isListingText } from './clean-core.ts';

/** `[south, west, north, east]` in degrees. */
export type StateExtent = readonly [south: number, west: number, north: number, east: number];

type Line = { fields: string[]; line: number };

/** Throws a static code; the line number rides along as data, never in the message. */
function fail(code: string, line?: number): never {
	const error: Error & { line?: number } = new Error(code);
	if (line !== undefined) error.line = line;
	throw error;
}

// The Census files write a longitude east of Greenwich with a leading plus sign.
const NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/;

function toNumber(text: string, line: number): number {
	if (!NUMBER_RE.test(text)) fail('E_TABLE_LINE', line);
	return Number(text);
}

/** Where each wanted column sits in a header, found by name so a reordered file still reads right. */
function columnIndex<Name extends string>(
	header: readonly string[],
	wanted: readonly Name[]
): Record<Name, number> {
	const index: Partial<Record<Name, number>> = {};
	for (const name of wanted) {
		const at = header.indexOf(name);
		if (at < 0) fail('E_TABLE_HEADER');
		index[name] = at;
	}
	return index as Record<Name, number>;
}

/** A pipe-delimited file with a header row: its rows, each trimmed and checked for the header's width. */
function readPipeTable<Name extends string>(
	text: string,
	wanted: readonly Name[]
): { index: Record<Name, number>; rows: Line[] } {
	const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
	if (lines[lines.length - 1] === '') lines.pop();
	const [headerLine, ...body] = lines;
	if (headerLine === undefined) fail('E_TABLE_HEADER');
	const header = headerLine.split('|').map((f) => f.trim());
	const index = columnIndex(header, wanted);
	const rows = body.map((l, at) => {
		const fields = l.split('|').map((f) => f.trim());
		if (fields.length !== header.length) fail('E_TABLE_LINE', at + 2);
		return { fields, line: at + 2 };
	});
	return { index, rows };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000 + 0;

const GEOID_RE = /^\d{5}$/;
const STATE_SET: ReadonlySet<string> = new Set(STATE_CODES);

/**
 * The USPS code of each state FIPS, read from the counties gazetteer: a county GEOID is its state's two FIPS digits
 * then three of its own. Read from the file rather than written out, so no code here can drift from the Census.
 */
function stateOfFips(countiesText: string): Map<string, string> {
	const { index, rows } = readPipeTable(countiesText, ['USPS', 'GEOID'] as const);
	const states = new Map<string, string>();
	for (const { fields, line } of rows) {
		const usps = fields[index.USPS] ?? '';
		const geoid = fields[index.GEOID] ?? '';
		if (usps === '' || !GEOID_RE.test(geoid)) fail('E_TABLE_LINE', line);
		const fips = geoid.slice(0, 2);
		const known = states.get(fips);
		if (known !== undefined && known !== usps) fail('E_TABLE_LINE', line);
		states.set(fips, usps);
	}
	return states;
}

type LandWater = { land: number; water: number };

/** Land and water of each ZCTA by state FIPS, summed over its counties. Rows with no ZCTA are counties without one. */
function areaByFips(relationshipText: string): Map<string, Map<string, LandWater>> {
	const { index, rows } = readPipeTable(relationshipText, [
		'GEOID_ZCTA5_20',
		'GEOID_COUNTY_20',
		'AREALAND_PART',
		'AREAWATER_PART'
	] as const);
	const byZcta = new Map<string, Map<string, LandWater>>();
	for (const { fields, line } of rows) {
		const zcta = fields[index.GEOID_ZCTA5_20] ?? '';
		if (zcta === '') continue;
		const countyGeoid = fields[index.GEOID_COUNTY_20] ?? '';
		if (!GEOID_RE.test(zcta) || !GEOID_RE.test(countyGeoid)) fail('E_TABLE_LINE', line);
		const land = toNumber(fields[index.AREALAND_PART] ?? '', line);
		const water = toNumber(fields[index.AREAWATER_PART] ?? '', line);
		const fips = countyGeoid.slice(0, 2);
		const parts = byZcta.get(zcta) ?? new Map<string, LandWater>();
		const sum = parts.get(fips) ?? { land: 0, water: 0 };
		parts.set(fips, { land: sum.land + land, water: sum.water + water });
		byZcta.set(zcta, parts);
	}
	return byZcta;
}

/**
 * The state holding most of a ZCTA's land; a tie goes to the larger water, then to the lower state code, so the
 * answer never depends on the order of the file.
 */
function stateOfZcta(
	parts: ReadonlyMap<string, LandWater> | undefined,
	states: ReadonlyMap<string, string>
): StateCode {
	if (parts === undefined) fail('E_ZIP_NO_STATE');
	let best: { state: string; area: LandWater } | undefined;
	for (const [fips, area] of parts) {
		const state = states.get(fips);
		if (state === undefined || !STATE_SET.has(state)) fail('E_ZIP_NO_STATE');
		const wins =
			best === undefined ||
			area.land > best.area.land ||
			(area.land === best.area.land &&
				(area.water > best.area.water || (area.water === best.area.water && state < best.state)));
		if (wins) best = { state, area };
	}
	if (best === undefined) fail('E_ZIP_NO_STATE');
	return best.state as StateCode;
}

/**
 * One row per ZCTA: `[zip, state, lat, lon]`, the point from the ZCTA gazetteer and the state from the Census
 * ZCTA-to-county relationship file, whose county GEOIDs are turned into states with the counties gazetteer.
 */
export function zipsFromGazetteer(
	zctaText: string,
	relationshipText: string,
	countiesText: string
): ZipsTable {
	const { index, rows } = readPipeTable(zctaText, ['GEOID', 'INTPTLAT', 'INTPTLONG'] as const);
	const states = stateOfFips(countiesText);
	const areas = areaByFips(relationshipText);
	const seen = new Set<string>();
	const out: [string, StateCode, number, number][] = [];
	for (const { fields, line } of rows) {
		const geoid = fields[index.GEOID] ?? '';
		if (!GEOID_RE.test(geoid) || seen.has(geoid)) fail('E_TABLE_LINE', line);
		seen.add(geoid);
		out.push([
			geoid,
			stateOfZcta(areas.get(geoid), states),
			round3(toNumber(fields[index.INTPTLAT] ?? '', line)),
			round3(toNumber(fields[index.INTPTLONG] ?? '', line))
		]);
	}
	out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const table: ZipsTable = { v: 1, rows: out };
	if (!validateZips(table).valid) fail('E_TABLE_INVALID');
	return table;
}

/** Quoted CSV: commas and line breaks inside quotes, doubled quotes for a quote, any other stray quote refused. */
function readCsv(text: string): Line[] {
	const records: Line[] = [];
	let fields: string[] = [];
	let field = '';
	let inQuotes = false;
	let closed = false;
	let line = 1;
	let recordLine = 1;
	const endRecord = () => {
		fields.push(field);
		records.push({ fields, line: recordLine });
		fields = [];
		field = '';
		closed = false;
		recordLine = line;
	};
	for (let at = 0; at < text.length; at++) {
		const char = text[at];
		if (inQuotes) {
			if (char === '"' && text[at + 1] === '"') {
				field += '"';
				at++;
			} else if (char === '"') {
				inQuotes = false;
				closed = true;
			} else {
				if (char === '\n') line++;
				field += char;
			}
			continue;
		}
		const newline = char === '\n' || (char === '\r' && text[at + 1] === '\n');
		if (closed && char !== ',' && !newline) fail('E_TABLE_LINE', line);
		if (char === '"') {
			if (field !== '') fail('E_TABLE_LINE', line);
			inQuotes = true;
		} else if (char === ',') {
			fields.push(field);
			field = '';
			closed = false;
		} else if (newline) {
			if (char === '\r') at++;
			line++;
			endRecord();
		} else {
			field += char;
		}
	}
	if (inQuotes) fail('E_TABLE_LINE', recordLine);
	if (field !== '' || fields.length > 0 || closed) endRecord();
	return records;
}

// The service letters of the O*NET file's own legend; a letter not listed here is a new kind of code that
// someone must look at, so it stops the build instead of being filed under a guess.
const BRANCH_OF_SERVICE = new Map<string, Branch>([
	...(['A', 'J', 'Q'] as const).map((s) => [s, 'Army'] as const),
	['C', 'Coast Guard'] as const,
	...(['F', 'X', 'Y', 'Z'] as const).map((s) => [s, 'Air Force'] as const),
	...(['H', 'L', 'O', 'U'] as const).map((s) => [s, 'Space Force'] as const),
	['M', 'Marine Corps'] as const,
	...(['N', 'P', 'S', 'V'] as const).map((s) => [s, 'Navy'] as const)
]);
// Defense occupational conversion codes, OPM civilian series and NSPS civilian codes: not military job codes.
const NOT_MILITARY = new Set(['D', 'G', 'K']);

const MOC_RE = /^[0-9A-Z]{2,6}$/;
const ONET_RE = /^\d{2}-\d{4}\.\d{2}$/;
const ONET_TITLE_MAX = 150;
const PAIRS = [1, 2, 3, 4] as const;
const CROSSWALK_COLUMNS = [
	'SVC',
	'MPC',
	'MOC',
	'STATUS',
	...PAIRS.map((k) => `ONET${k}` as const),
	...PAIRS.map((k) => `ONET${k}_TITLE` as const)
] as const;

export function crosswalkFromCsv(text: string): {
	table: CrosswalkTable;
	skipped: Record<string, number>;
} {
	const [headerRecord, ...body] = readCsv(text);
	if (headerRecord === undefined) fail('E_TABLE_HEADER');
	const header = headerRecord.fields.map((f) => f.trim());
	const index = columnIndex(header, CROSSWALK_COLUMNS);
	const skipped: Record<string, number> = {};
	const skip = (reason: string) => {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	};
	const unique = new Map<string, [string, string, string, string]>();
	for (const { fields, line } of body) {
		if (fields.length !== header.length) fail('E_TABLE_LINE', line);
		const at = (name: (typeof CROSSWALK_COLUMNS)[number]) => (fields[index[name]] ?? '').trim();
		if (at('STATUS') !== 'A') continue;
		const service = at('SVC');
		const branch = BRANCH_OF_SERVICE.get(service);
		if (branch === undefined) {
			if (!NOT_MILITARY.has(service)) fail('E_TABLE_LINE', line);
			skip('NOT_MILITARY');
			continue;
		}
		if (at('MPC') === '-') {
			skip('CIVILIAN');
			continue;
		}
		const code = at('MOC');
		if (!MOC_RE.test(code)) {
			skip('MOC_SHAPE');
			continue;
		}
		for (const k of PAIRS) {
			const onet = at(`ONET${k}`);
			if (onet === '') continue;
			const title = at(`ONET${k}_TITLE`);
			if (!ONET_RE.test(onet) || !isListingText(title) || title.length > ONET_TITLE_MAX) {
				skip('ONET_SHAPE');
				continue;
			}
			unique.set(JSON.stringify([code, branch, onet]), [code, branch, onet, title]);
		}
	}
	const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	const rows = [...unique.values()].sort(
		(a, b) => compare(a[0], b[0]) || compare(a[1], b[1]) || compare(a[2], b[2])
	);
	const table: CrosswalkTable = { v: 1, rows };
	if (!validateCrosswalk(table).valid) fail('E_TABLE_INVALID');
	return { table, skipped };
}

const KM_PER_DEGREE = 111.32;
const MARGIN_DEGREES = 0.1;

const floor2 = (value: number) => Math.floor(value * 100) / 100;
const ceil2 = (value: number) => Math.ceil(value * 100) / 100;
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/**
 * A box per state that holds every real point of it. The gazetteer gives each county one interior point, not its
 * edges, so each county is padded by twice the radius of a circle of its own area: generous, so the clean step
 * rejects only coordinates that are clearly wrong. A state's box is the union of its counties' boxes, widened by a
 * margin and rounded outward to two decimals.
 */
export function stateExtentsFromCounties(text: string): Partial<Record<StateCode, StateExtent>> {
	const { index, rows } = readPipeTable(text, [
		'USPS',
		'ALAND',
		'AWATER',
		'INTPTLAT',
		'INTPTLONG'
	] as const);
	const boxes = new Map<StateCode, [number, number, number, number]>();
	for (const { fields, line } of rows) {
		const usps = fields[index.USPS] ?? '';
		if (!STATE_SET.has(usps)) continue;
		const area =
			toNumber(fields[index.ALAND] ?? '', line) + toNumber(fields[index.AWATER] ?? '', line);
		const lat = toNumber(fields[index.INTPTLAT] ?? '', line);
		const written = toNumber(fields[index.INTPTLONG] ?? '', line);
		// Every area lies west of Greenwich; only the western Aleutians cross 180 degrees, and the file then
		// writes their longitude as east. Read as the same place west of Greenwich, so a state's box does not
		// run east across Asia and Europe to reach it.
		const lon = written > 0 ? written - 360 : written;
		const radiusKm = Math.sqrt(area / Math.PI) / 1000;
		const padLat = (2 * radiusKm) / KM_PER_DEGREE;
		const padLon = (2 * radiusKm) / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
		const code = usps as StateCode;
		const box = boxes.get(code) ?? [Infinity, Infinity, -Infinity, -Infinity];
		box[0] = Math.min(box[0], lat - padLat);
		box[1] = Math.min(box[1], lon - padLon);
		box[2] = Math.max(box[2], lat + padLat);
		box[3] = Math.max(box[3], lon + padLon);
		boxes.set(code, box);
	}
	const extents: Partial<Record<StateCode, StateExtent>> = {};
	for (const code of STATE_CODES) {
		const box = boxes.get(code);
		if (box === undefined) continue;
		extents[code] = [
			clamp(floor2(box[0] - MARGIN_DEGREES), 90),
			clamp(floor2(box[1] - MARGIN_DEGREES), 180),
			clamp(ceil2(box[2] + MARGIN_DEGREES), 90),
			clamp(ceil2(box[3] + MARGIN_DEGREES), 180)
		];
	}
	return extents;
}

/** The full text of the app's `state-extents.ts`, states in contract order, already in the repo's formatting. */
export function stateExtentsSource(
	extents: Partial<Record<StateCode, StateExtent>>,
	sourceName: string
): string {
	const entries = STATE_CODES.flatMap((code) => {
		const box = extents[code];
		return box === undefined ? [] : [`\t${code}: [${box.join(', ')}]`];
	});
	return `/**
 * A padded box around each state, built from the ${sourceName}.
 * A point outside its state's box is surely not in that state; a point inside may still be in a neighbour, so
 * the box checks for clearly wrong coordinates and answers a coarse "which regions are near" question, and is
 * never a border. Territories without Census counties have no box.
 * Generated by content-ops/skillbridge/tables.mjs: edit the generator, not this file.
 */

import type { StateCode } from './places';

/** \`[south, west, north, east]\` in degrees. */
export type StateExtent = readonly [south: number, west: number, north: number, east: number];

export const STATE_EXTENTS: Readonly<Partial<Record<StateCode, StateExtent>>> = {
${entries.join(',\n')}
};

/** True when the point lies in the state's box (edges included); undefined when the state has no box. */
export function isInStateExtent(code: StateCode, la: number, lo: number): boolean | undefined {
	const extent = STATE_EXTENTS[code];
	if (extent === undefined) return undefined;
	const [south, west, north, east] = extent;
	return la >= south && la <= north && lo >= west && lo <= east;
}
`;
}

/** The operating system's own path resolution: follows links and junctions, expands short names, fixes case. */
export const DEFAULT_REALPATH: (path: string) => string = realpathSync.native;

const WINDOWS = process.platform === 'win32';
// "\\?\C:\x" names the same folder as "C:\x" with the path checks of Windows switched off.
const VERBATIM_DRIVE_RE = /^[\\/]{2}\?[\\/](?=[A-Za-z]:)/;
const NETWORK_RE = /^[\\/]{2}/;
// Windows opens "name." and "name " as "name".
const TRAILING_DOTS_AND_SPACES_RE = /[. ]+$/;

/** The path without a verbatim prefix; undefined for a network or device path, which cannot be compared. */
function plainPath(path: string): string | undefined {
	if (!WINDOWS) return path;
	const plain = path.replace(VERBATIM_DRIVE_RE, '');
	return NETWORK_RE.test(plain) ? undefined : plain;
}

/**
 * Where a path really lies: the deepest folder of it that exists is resolved by the operating system (so a link
 * or junction is followed), and the part that does not exist yet is kept as written, minus the dots and spaces
 * Windows ignores at the end of a name. Undefined when the path is one that cannot be compared.
 */
function realLocation(path: string, realpath: (path: string) => string): string | undefined {
	const plain = plainPath(path);
	if (plain === undefined) return undefined;
	const absolute = resolve(plain);
	const { root } = parse(absolute);
	const names = absolute
		.slice(root.length)
		.split(sep)
		.map((name) => (WINDOWS ? name.replace(TRAILING_DOTS_AND_SPACES_RE, '') : name))
		.filter((name) => name !== '');
	for (let kept = names.length; kept >= 0; kept--) {
		try {
			const head = realpath(join(root, ...names.slice(0, kept)));
			return join(plainPath(head) ?? head, ...names.slice(kept));
		} catch {
			// This folder does not exist yet; look one folder up.
		}
	}
	return join(root, ...names);
}

/**
 * True when `target` is `folder` or lies inside it, comparing where each really is, so a link, a junction, a
 * short name or a Windows spelling of the folder cannot read as outside it. A network or device path cannot be
 * checked, so it counts as inside.
 */
export function isInsideFolder(
	folder: string,
	target: string,
	realpath: (path: string) => string = DEFAULT_REALPATH
): boolean {
	const from = realLocation(folder, realpath);
	const to = realLocation(target, realpath);
	if (from === undefined || to === undefined) return true;
	const path = relative(from, to);
	if (path === '') return true;
	return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}
