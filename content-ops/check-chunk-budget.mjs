// Run after `pnpm build`: `pnpm check:chunks` (CI gate). Budgets the built client's shared chunks by HOW
// THEY LOAD rather than as one sum: the chunks a page downloads, and the chunks fetched only on demand. A
// single sum counted the PDF viewer - which loads only when someone opens a document - against every page
// load, so it could no longer say what the budget exists to say. It also budgets the service worker's
// precache: every file the worker downloads at install, for every visitor, before anything is asked of it.
//
// Sizes are measured exactly as size-limit measures them - gzip at level 9, limits in metric kilobytes
// (50 KB = 50,000 bytes) - so the page budget keeps the meaning it had as a size-limit entry.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { precachedPaths, splitChunksByLoading } from '../src/lib/ci/chunk-budget-policy.ts';

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
//
// Raise a limit only with a measured reason recorded here; never to make a run pass.
const LIMIT = { page: 55_800, onDemand: 7_300, precacheFiles: 60, precacheBytes: 133_000 };

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

const rows = [
	{ label: 'chunks a page downloads', files: page, limit: LIMIT.page },
	{ label: 'chunks loaded on demand', files: onDemand, limit: LIMIT.onDemand }
];
let failed = 0;
for (const { label, files, limit } of rows) {
	const size = total(files);
	const pass = size <= limit;
	if (!pass) failed += 1;
	console.log(
		`    ${label.padEnd(26)} ${(size / 1000).toFixed(2).padStart(8)} KB  <= ${(limit / 1000).toFixed(0)} KB  ${pass ? 'PASS' : 'FAIL'}  (${files.length} files)`
	);
}

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

const precacheBytes = total(precached.map((path) => path.slice(1)));
const filesPass = precached.length <= LIMIT.precacheFiles;
const bytesPass = precacheBytes <= LIMIT.precacheBytes;
if (!filesPass) failed += 1;
if (!bytesPass) failed += 1;
console.log(
	`    ${'files the worker precaches'.padEnd(26)} ${String(precached.length).padStart(8)}     <= ${LIMIT.precacheFiles}      ${filesPass ? 'PASS' : 'FAIL'}`
);
console.log(
	`    ${'bytes the worker precaches'.padEnd(26)} ${(precacheBytes / 1000).toFixed(2).padStart(8)} KB  <= ${(LIMIT.precacheBytes / 1000).toFixed(0)} KB  ${bytesPass ? 'PASS' : 'FAIL'}`
);

if (failed > 0) {
	console.log(
		`\nCHUNK BUDGET FAILED on ${failed} budget(s). Do not raise a limit to make this pass.`
	);
	throw new Error('E_CHUNK_BUDGET_FAILED');
}
console.log('\nCHUNK BUDGET PASSED');
