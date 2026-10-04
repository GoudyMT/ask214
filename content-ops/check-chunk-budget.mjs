// Run after `pnpm build`: `pnpm check:chunks` (CI gate). Budgets the built client's shared chunks by HOW
// THEY LOAD rather than as one sum: the chunks a page downloads, and the chunks fetched only on demand. A
// single sum counted the PDF viewer - which loads only when someone opens a document - against every page
// load, so it could no longer say what the budget exists to say. It also budgets the service worker's
// precache: every file the worker downloads at install, for every visitor, before anything is asked of it.
//
// Sizes are measured exactly as size-limit measures them - gzip at level 9, limits in metric kilobytes
// (50 KB = 50,000 bytes) - so the page budget keeps the meaning it had as a size-limit entry.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import {
	kilobytes,
	precachedPaths,
	roomInBytes,
	splitChunksByLoading,
	strayWasm,
	unreadWorkerScripts,
	SHELL_BYTES_ALLOWANCE
} from '../src/lib/ci/chunk-budget-policy.ts';
import { INSTALL_PAGES, workerScriptsNamed } from '../src/lib/ask/asset-cache.ts';

const CLIENT = '.svelte-kit/output/client';
const CHUNK_DIR = `${CLIENT}/_app/immutable/chunks`;
// SvelteKit's static folder (the default; svelte.config.js does not move it). Its files are the worker's `files`.
const STATIC = 'static';

// Pre-registered limits.
//
//   page 55,439. Was 50,000, the limit the summed size-limit entry carried; the summed entry read 46.93 KB
//     before the reader's page view existed, and split, the page chunks measured 47.92 KB with it.
//     Re-derived when the Documents page began opening the reader too: a module two routes share leaves
//     their route nodes for a shared chunk, so the reader (5,439 B measured) moved from the route-node
//     budget to this one. Its bytes moved with it - this limit rose by 5,439 and the route-node limit in
//     package.json fell by the same, so the two together still allow 95,000. Measured at the move: page
//     54.87 KB, route nodes 39,527 B. What one visitor downloads rose 0.1-1.6 KB on the existing pages.
//     The route-node limit then rose 39,561 -> 40,100 (so together 95,539): the Documents area's offline line
//     that says only what opens, the save-all question naming the page reader, and older copies counted and
//     removable on the Documents page and in Settings measured 40,048 B after a trim pass (-31 B).
//     Raised 55,439 -> 55,800 (owner's call, 2026-09-25): the reader keeping focus where the user put it, its
//     notices saying why it shows text, and saves already running shown wherever a Save is built, measured
//     55,708 B after a trim pass (-246 B: one lazy file for the reader's parts, one title bar snippet, focus
//     given back by each control's own name). The route-node limit rose 40,100 -> 40,700 at the same time:
//     the Documents list keeping focus when its control goes, its live lines in place before they speak, a
//     save already running shown on arrival, the answer library named in the save-all question, and a size
//     that cannot be read left out - 40,594 B measured. Each keeps about 100 B of room; the route-node sum
//     alone moves by up to 74 B when the minifier renames the shared chunk's exports.
//     The route-node limit rose 40,700 -> 41,000 (owner's call, 2026-09-26): the home page waiting for the
//     service worker before its first download, reading from the cache whether the device keeps every
//     on-device file, and the setup copy stating the real size - 40,887 B measured after a trim pass (-43 B:
//     one cache lookup per file, the source map out of reactive state).
//     Raised 41,000 -> 41,200 (owner's call, 2026-09-27): the review fixes to that wait - a setup left behind
//     when the page is left starts nothing, a mode or feed question tapped before the page is ready is kept,
//     the cache read is capped at 2 s, and a page no worker will control stops waiting - 41,093 B measured after
//     a trim pass (-14 B: the held mode starts at the saved default).
//     Page 55,800 -> 56,000 and route nodes 41,200 -> 41,078 (owner's call, 2026-09-30): the Documents page now
//     waits for the service worker before it loads the answer library, as the home page does, so the wait -
//     shared by the two routes - left the home page's route node for their shared chunk (+211 B here, -169 B
//     there); 122 B moved between the two limits, plus room. Measured after a trim pass (-2 B: the page's left
//     flag set in its existing cleanup): page 55,926 B, route nodes 41,004 B - each keeps about 75 B of room,
//     because builds of the same code differ by a few bytes with SvelteKit's per-build global name.
//     Page 56,000 -> 58,100 and route nodes 41,078 -> 42,350 (owner's call, 2026-10-03): deadline reminders -
//     the calendar file's event per moment with its alerts and the sentence under the button (+1,441 B, a page
//     chunk), the task card's new states and the "Needs you now" summary (+1,215 B, the timeline's route node),
//     and the What now links (+667 B, the resources chunk). Measured after a trim pass (-16 B page, -40 B route
//     nodes, -41 B precache: the snooze date and the calendar end date reuse the shared whole-day math; loading
//     the calendar builder only on the tap measured worse on three budgets, because every install precaches it
//     anyway):
//     page 58,018 B, route nodes 42,259 B - each keeps about 85 B of room.
//     Page 58,100 -> 58,230 and route nodes 42,350 -> 42,500 (owner's call, 2026-10-03): the pre-merge review's
//     fixes - today read from the device clock, the corrected task copy, a required task closing after
//     separation and the installed iPhone sentence (+160 B, a page chunk), the add offered only when the file
//     would hold an event (+79 B, the Settings and timeline route nodes), and the task card's Snooze rule, link
//     line, focus target and spaced tags. Measured after a trim pass (-221 B page: the installed check read
//     inline, so install-state is not split into a chunk of its own; reusing the iPhone sentence's text measured
//     6 B worse and was dropped): page 58,143 B, route nodes 42,410 B - each keeps about 90 B of room.
//     Measured after the re-review's fixes, with no raise: page 58,220 B (10 B of room), route nodes
//     42,491 B (9 B).
//   onDemand 7,000. Measured 5.16 KB: the reader's page view, and nothing else of weight. The PDF library
//     is NOT here - it is vendored into its own lazy folder and loaded by URL, so the bundler never emits it.
//     Kept tight on purpose: an on-demand chunk is still a build file, and the service worker precaches
//     every build file at install, so bytes here are downloaded by every visitor's install even though no
//     page loads them. A library slipping back into the build fails this by a wide margin.
//     (First registered at 140 KB, against 132.72 KB, while the library was still bundled.)
//     Raised 7,000 -> 7,300 (owner's call, 2026-09-25): the page view keeping the reader's place through a
//     turned phone, a view switch and lines above it changing, every page sized from its own shape, a landing
//     that takes focus only when allowed, the top line for guides that kept some pictures, and the Save's
//     line about the answer library - 7,206 B measured, after one lazy file for the reader's parts (-625 B).
//   Cross-checked when this replaced the summed entry: 47.92 + 132.72 = 180.64 KB, size-limit's own figure
//   for the same build.
//   precacheFiles 60, precacheBytes 133,000. Measured at registration: 59 files (54 build files + 5 static)
//     and 130,811 B. `main` precached 39 build files before the source document arrived. The count is
//     budgeted as well as the bytes: on a first visit the install runs beside the page, and with the larger
//     precache a tap during it stalled the next page ~500 ms on WebKit (6 of 8 runs; 0 of 45 before).
//     Each page kept at install (INSTALL_PAGES) counts as one file, weighed by SHELL_BYTES_ALLOWANCE.
//     Raised 133,000 -> 134,800 (owner's call, 2026-09-26): the shell page itself (1,600 B allowance, 1,469 B
//     measured - generated by SvelteKit, so there is nothing to trim) and the home page's new code - 134,700 B
//     measured with 55 files, after the trim pass above.
//     Raised 134,800 -> 135,100 (owner's call, 2026-09-27): the same review fixes as the route-node raise, and
//     the reader's title given its own full-width row - 134,970 B measured with 55 files, after that trim pass.
//     Raised 135,100 -> 135,200 (owner's call, 2026-09-30): the Documents page's wait, above - 135,112 B measured
//     with 55 files, after that trim pass.
//     Raised 135,200 -> 139,060 (owner's call, 2026-10-03): the deadline reminders, above - 138,974 B measured
//     with 55 files, after that trim pass.
//     Raised 139,060 -> 139,350 (owner's call, 2026-10-03): the review's fixes, above - 139,264 B measured with
//     55 files, after that trim pass.
//     Raised 139,350 -> 139,440 (owner's call, 2026-10-03): each calendar event's rising version and the Settings
//     line about removing old events after a date change - 139,348 B measured with 55 files, after a trim pass
//     (-41 B: the version as plain minutes since 1970, and the line sharing the device sentence's spacing rule).
//     Measured after the re-review's fixes, with no raise: 139,432 B (8 B of room); the version now counts whole
//     seconds since 2000, so two adds a second apart differ.
//   workerScripts 147,200. The gzip-9 total of every script under _app/immutable/workers/: the embed worker's own
//     code, which a device downloads the first time it asks a question on-device. The worker script's download
//     deadline (WORKER_SCRIPT_DEADLINE_MS, 20 s) assumes this size, so growth is budgeted here. Measured 147,077 B
//     (this check's own gzip-9), 123 B of room (owner's call, 2026-09-30). A transformers.js, onnxruntime or Vite
//     update can grow the worker past it; a raise then is expected, on a measured reason and as the owner's call,
//     as for every limit here. The budget exists to make that growth a decision, not a surprise.
//
// Raise a limit only with a measured reason recorded here; never to make a run pass.
const LIMIT = {
	page: 58_230,
	onDemand: 7_300,
	precacheFiles: 60,
	precacheBytes: 139_440,
	workerScripts: 147_200
};

/**
 * @param {string} file A path as the manifest names it, relative to the client output.
 * @returns {number} Gzipped bytes at level 9, as size-limit counts them.
 */
function gzipped(file) {
	return gzipSync(readFileSync(`${CLIENT}/${file}`), { level: 9 }).length;
}

/**
 * @param {string[]} files
 * @returns {number}
 */
function total(files) {
	return files.reduce((sum, file) => sum + gzipped(file), 0);
}

const manifest = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf-8'));
const { page, onDemand } = splitChunksByLoading(manifest);

console.log('='.repeat(60));
console.log('CHUNK BUDGET');
console.log('='.repeat(60));

// Instrument check, before any size: every chunk on disk must be in exactly one list. A chunk the manifest
// did not describe would otherwise escape both budgets and read as a pass.
const onDisk = readdirSync(CHUNK_DIR)
	.filter((f) => f.endsWith('.js'))
	.map((f) => `_app/immutable/chunks/${f}`)
	.sort();
const classified = [...page, ...onDemand].sort();
const accounted =
	onDisk.length === classified.length && onDisk.every((file, i) => file === classified[i]);
console.log(
	`    chunks on disk ${onDisk.length}, classified ${classified.length}: ${accounted ? 'ALL ACCOUNTED FOR' : 'MISMATCH'}`
);
if (!accounted) {
	for (const file of onDisk.filter((f) => !classified.includes(f)))
		console.log(`    unclassified ${file}`);
	throw new Error('E_CHUNK_BUDGET_UNCLASSIFIED');
}

let failed = 0;

/**
 * Print one size row against its limit, and count it when it fails. The limit prints with the size's precision.
 *
 * @param {string} label
 * @param {string[]} files Paths relative to the client output.
 * @param {number} limit Gzipped bytes.
 */
function sizeRow(label, files, limit) {
	const size = total(files);
	const pass = size <= limit;
	if (!pass) failed += 1;
	console.log(
		`    ${label.padEnd(26)} ${kilobytes(size).padStart(8)} KB  <= ${kilobytes(limit)} KB  ${pass ? 'PASS' : 'FAIL'}  (${files.length} files, ${roomInBytes(size, limit)})`
	);
}

sizeRow('chunks a page downloads', page, LIMIT.page);
sizeRow('chunks loaded on demand', onDemand, LIMIT.onDemand);

// The precache, read from the built worker's own list and filtered by the worker's own rule.
const { listed, precached } = precachedPaths(readFileSync(`${CLIENT}/service-worker.js`, 'utf-8'));

// Instrument check, before any size: the list read from the worker must be exactly the build's own files plus
// the static folder. A reading that lost entries would count too few files and pass.
const built = Object.values(manifest).flatMap((chunk) => [
	chunk.file,
	...(chunk.css ?? []),
	...(chunk.assets ?? [])
]);
const statics = readdirSync(STATIC, { recursive: true })
	.map((path) => String(path).replaceAll('\\', '/'))
	.filter((path) => statSync(`${STATIC}/${path}`).isFile());
const expected = new Set([...built, ...statics].map((path) => `/${path}`));
const listedAll = listed.length === expected.size && listed.every((path) => expected.has(path));
console.log(
	`    worker lists ${listed.length}, build and static files ${expected.size}: ${listedAll ? 'ALL ACCOUNTED FOR' : 'MISMATCH'}`
);
if (!listedAll) {
	for (const path of listed.filter((p) => !expected.has(p)))
		console.log(`    listed, not built ${path}`);
	for (const path of [...expected].filter((p) => !listed.includes(p)))
		console.log(`    built, not listed ${path}`);
	throw new Error('E_PRECACHE_LIST_MISMATCH');
}

// The worker also keeps INSTALL_PAGES at install: one file each, weighed by the allowance because each is a served
// page, not a built file.
const precacheFiles = precached.length + INSTALL_PAGES.length;
const precacheBytes =
	total(precached.map((path) => path.slice(1))) + INSTALL_PAGES.length * SHELL_BYTES_ALLOWANCE;
const filesPass = precacheFiles <= LIMIT.precacheFiles;
const bytesPass = precacheBytes <= LIMIT.precacheBytes;
if (!filesPass) failed += 1;
if (!bytesPass) failed += 1;
console.log(
	`    ${'files the worker precaches'.padEnd(26)} ${String(precacheFiles).padStart(8)}     <= ${LIMIT.precacheFiles}      ${filesPass ? 'PASS' : 'FAIL'}`
);
console.log(
	`    ${'bytes the worker precaches'.padEnd(26)} ${kilobytes(precacheBytes).padStart(8)} KB  <= ${kilobytes(LIMIT.precacheBytes)} KB  ${bytesPass ? 'PASS' : 'FAIL'}  (${roomInBytes(precacheBytes, LIMIT.precacheBytes)})`
);

// Instrument check: install keeps the embed worker's script by reading its name from the built code, because the
// build list the worker precaches leaves worker scripts out. Every script the build wrote must be found that way,
// or the script silently stops being kept for a device that set up on-device answers. Every folder under the
// worker's is read, not only the top one: a worker's split code is written to a subfolder, and install keeps
// nothing it does not find by name there.
const WORKERS = '_app/immutable/workers';
const scriptsOnDisk = existsSync(`${CLIENT}/${WORKERS}`)
	? readdirSync(`${CLIENT}/${WORKERS}`, { recursive: true })
			.map((f) => String(f).replaceAll('\\', '/'))
			.filter((f) => f.endsWith('.js'))
			.map((f) => `/${WORKERS}/${f}`)
			.sort()
	: [];
const scriptsNamed = [
	...new Set(
		built
			.filter((file) => file.endsWith('.js'))
			.flatMap((file) => workerScriptsNamed(`/${file}`, readFileSync(`${CLIENT}/${file}`, 'utf-8')))
	)
].sort();
// The app always ships the embed worker, so none on disk is a failure, not a pass with nothing to check.
/** @type {string[]} */
let unread;
try {
	unread = unreadWorkerScripts(scriptsNamed, scriptsOnDisk);
} catch (error) {
	console.log(
		`    worker scripts on disk ${scriptsOnDisk.length}, named by the built code ${scriptsNamed.length}: NONE ON DISK`
	);
	throw error;
}
console.log(
	`    worker scripts on disk ${scriptsOnDisk.length}, named by the built code ${scriptsNamed.length}: ${unread.length === 0 ? 'ALL FOUND' : 'MISSED'}`
);
if (unread.length > 0) {
	for (const script of unread) console.log(`    not named by any built code ${script}`);
	throw new Error('E_WORKER_SCRIPT_UNREAD');
}

// The worker script is fetched under its own deadline (WORKER_SCRIPT_DEADLINE_MS), which assumes the size
// measured below; a script that grows past it can miss that deadline on a slow connection.
sizeRow(
	'worker scripts',
	scriptsOnDisk.map((script) => script.slice(1)),
	LIMIT.workerScripts
);

// Instrument check: the worker loads its WASM from the vendored /wasm/ folder only. A copy written anywhere else
// is never requested and ships to every visitor's release - the runtime library inside the worker names one as a
// fallback, and the bundler writes it beside the worker's script.
const builtFiles = readdirSync(CLIENT, { recursive: true })
	.map((path) => String(path).replaceAll('\\', '/'))
	.filter((path) => statSync(`${CLIENT}/${path}`).isFile());
const stray = strayWasm(builtFiles);
console.log(
	`    wasm files outside /wasm/ ${stray.length}: ${stray.length === 0 ? 'NONE' : 'FOUND'}`
);
if (stray.length > 0) {
	for (const file of stray) console.log(`    wasm outside /wasm/ ${file}`);
	throw new Error('E_STRAY_WASM');
}

if (failed > 0) {
	console.log(
		`\nCHUNK BUDGET FAILED on ${failed} budget(s). Do not raise a limit to make this pass.`
	);
	throw new Error('E_CHUNK_BUDGET_FAILED');
}
console.log('\nCHUNK BUDGET PASSED');
