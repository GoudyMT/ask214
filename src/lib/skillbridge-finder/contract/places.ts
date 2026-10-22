/**
 * Where a listing lives and the only paths a client may request. The finder's privacy rests on this file: the
 * server sees which fixed file was asked for and nothing else, so every request path is built here from fixed
 * names and a checked pull date, never from anything a person typed.
 */

/** US state, DC and territory codes the listings use; anything else is quarantined by the pipeline. */
export const STATE_CODES = [
	'AK',
	'AL',
	'AR',
	'AS',
	'AZ',
	'CA',
	'CO',
	'CT',
	'DC',
	'DE',
	'FL',
	'GA',
	'GU',
	'HI',
	'IA',
	'ID',
	'IL',
	'IN',
	'KS',
	'KY',
	'LA',
	'MA',
	'MD',
	'ME',
	'MI',
	'MN',
	'MO',
	'MP',
	'MS',
	'MT',
	'NC',
	'ND',
	'NE',
	'NH',
	'NJ',
	'NM',
	'NV',
	'NY',
	'OH',
	'OK',
	'OR',
	'PA',
	'PR',
	'RI',
	'SC',
	'SD',
	'TN',
	'TX',
	'UT',
	'VA',
	'VI',
	'VT',
	'WA',
	'WI',
	'WV',
	'WY'
] as const;
export type StateCode = (typeof STATE_CODES)[number];

/** Territories have no Census division; their listings go to the `territories` file. */
export const TERRITORY_CODES: readonly StateCode[] = ['AS', 'GU', 'MP', 'PR', 'VI'];

/**
 * The nine Census divisions, the regions files are cut by: a public, stable grouping, coarse enough that the
 * file a person fetches does not name their state.
 */
export const DIVISIONS = [
	'new-england',
	'middle-atlantic',
	'east-north-central',
	'west-north-central',
	'south-atlantic',
	'east-south-central',
	'west-south-central',
	'mountain',
	'pacific'
] as const;
export type Division = (typeof DIVISIONS)[number];

// From the Census Bureau's division lists (census.gov, economic census "Geographic Levels").
const DIVISION_MEMBERS: Record<Division, readonly StateCode[]> = {
	'new-england': ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'],
	'middle-atlantic': ['NJ', 'NY', 'PA'],
	'east-north-central': ['IL', 'IN', 'MI', 'OH', 'WI'],
	'west-north-central': ['IA', 'KS', 'MN', 'MO', 'NE', 'ND', 'SD'],
	'south-atlantic': ['DE', 'DC', 'FL', 'GA', 'MD', 'NC', 'SC', 'VA', 'WV'],
	'east-south-central': ['AL', 'KY', 'MS', 'TN'],
	'west-south-central': ['AR', 'LA', 'OK', 'TX'],
	mountain: ['AZ', 'CO', 'ID', 'MT', 'NV', 'NM', 'UT', 'WY'],
	pacific: ['AK', 'CA', 'HI', 'OR', 'WA']
};

export const DIVISION_OF_STATE: Partial<Record<StateCode, Division>> = Object.fromEntries(
	DIVISIONS.flatMap((d) => DIVISION_MEMBERS[d].map((code) => [code, d]))
);

/** Every listing file a client may fetch: a division, or one of the five fixed files. */
export const REGION_FILE_NAMES = [
	...DIVISIONS,
	'multi-state',
	'remote',
	'territories',
	'overseas',
	'unknown'
] as const;
export type RegionFileName = (typeof REGION_FILE_NAMES)[number];

/** The supporting tables, served whole (never split by prefix, which would name a ZIP range). */
export const TABLE_FILE_NAMES = ['zips', 'crosswalk'] as const;
export type TableFileName = (typeof TABLE_FILE_NAMES)[number];

const REGION_SET: ReadonlySet<string> = new Set(REGION_FILE_NAMES);
const TABLE_SET: ReadonlySet<string> = new Set(TABLE_FILE_NAMES);

export function isRegionFileName(name: unknown): name is RegionFileName {
	return typeof name === 'string' && REGION_SET.has(name);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written `YYYY-MM-DD` (rejects `2026-02-30` and any other form). */
export function isIsoDate(s: unknown): s is string {
	if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
	const [y, m, d] = s.split('-').map(Number) as [number, number, number];
	// A day or month past its range rolls the date into another month, so the month alone tells.
	return new Date(Date.UTC(y, m - 1, d)).getUTCMonth() === m - 1;
}

export const DATA_ROOT = '/skillbridge-data';

export type DataFile =
	| { kind: 'index' }
	| { kind: 'region'; pullDate: string; name: RegionFileName }
	| { kind: 'ids' | 'changes'; pullDate: string }
	| { kind: 'table'; name: TableFileName };

/**
 * The request path for one data file. Throws on any name off the fixed lists or any pull date that is not a
 * real date, so a typed value can never reach a URL even through a cast.
 */
export function dataPath(file: DataFile): string {
	switch (file.kind) {
		case 'index':
			return `${DATA_ROOT}/index.json`;
		case 'table':
			if (!TABLE_SET.has(file.name)) throw new Error('E_SBF_BAD_PATH');
			return `${DATA_ROOT}/tables/${file.name}.json`;
		case 'region':
			if (!isIsoDate(file.pullDate) || !isRegionFileName(file.name))
				throw new Error('E_SBF_BAD_PATH');
			return `${DATA_ROOT}/w/${file.pullDate}/${file.name}.json`;
		case 'ids':
		case 'changes':
			if (!isIsoDate(file.pullDate)) throw new Error('E_SBF_BAD_PATH');
			return `${DATA_ROOT}/w/${file.pullDate}/${file.kind}.json`;
		default:
			throw new Error('E_SBF_BAD_PATH');
	}
}
