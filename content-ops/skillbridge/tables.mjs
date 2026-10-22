/**
 * Builds the SkillBridge finder's supporting tables from public datasets Max downloads by hand.
 *
 * Run: node --import tsx content-ops/skillbridge/tables.mjs --zcta <file> --crosswalk <file> --out <folder>
 *        writes <folder>/zips.json and <folder>/crosswalk.json (compact JSON) and prints their row counts.
 *      node --import tsx content-ops/skillbridge/tables.mjs --counties <file> --extents <path>
 *        writes the app's state-extents.ts source (format it with prettier afterwards).
 *
 * The output folder must lie outside the repo: the tables are deployed with the weekly data, not committed.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
	crosswalkFromCsv,
	isInsideFolder,
	stateExtentsFromCounties,
	stateExtentsSource,
	zipsFromGazetteer
} from './tables-core.ts';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const EXTENTS_SOURCE_NAME = 'Census Bureau 2026 counties gazetteer';

/**
 * @param {string} message
 * @returns {never}
 */
function stop(message) {
	console.error(message);
	process.exit(1);
}

/**
 * @param {string} path
 * @param {unknown} table
 */
function writeJson(path, table) {
	const body = JSON.stringify(table);
	writeFileSync(path, body);
	console.log(`${path}: ${Buffer.byteLength(body)} bytes`);
}

function main() {
	const { values } = parseArgs({
		options: {
			zcta: { type: 'string' },
			crosswalk: { type: 'string' },
			out: { type: 'string' },
			counties: { type: 'string' },
			extents: { type: 'string' }
		}
	});
	const tables =
		values.zcta !== undefined || values.crosswalk !== undefined || values.out !== undefined;
	const extents = values.counties !== undefined || values.extents !== undefined;
	if (!tables && !extents) stop('E_USAGE');

	if (tables) {
		const { zcta, crosswalk, out } = values;
		if (zcta === undefined || crosswalk === undefined || out === undefined) stop('E_USAGE');
		if (isInsideFolder(REPO_ROOT, out)) stop('E_OUT_INSIDE_REPO');
		const zips = zipsFromGazetteer(readFileSync(zcta, 'utf8'));
		const built = crosswalkFromCsv(readFileSync(crosswalk, 'utf8'));
		mkdirSync(out, { recursive: true });
		writeJson(join(out, 'zips.json'), zips);
		writeJson(join(out, 'crosswalk.json'), built.table);
		console.log(`zips: ${zips.rows.length} rows`);
		console.log(`crosswalk: ${built.table.rows.length} rows`);
		console.log(`crosswalk skipped: ${JSON.stringify(built.skipped)}`);
	}

	if (extents) {
		const { counties, extents: target } = values;
		if (counties === undefined || target === undefined) stop('E_USAGE');
		const boxes = stateExtentsFromCounties(readFileSync(counties, 'utf8'));
		writeFileSync(target, stateExtentsSource(boxes, EXTENTS_SOURCE_NAME));
		console.log(`state extents: ${Object.keys(boxes).length} states`);
	}
}

try {
	main();
} catch (error) {
	const line = error instanceof Error && 'line' in error ? ` (line ${String(error.line)})` : '';
	stop((error instanceof Error ? error.message : 'E_UNKNOWN') + line);
}
