/**
 * Refuse a pull request whose commits carry a served document the manifest at its head does not record.
 *
 * The served documents re-host government PDFs with every picture not marked Public Domain removed. A pull
 * request publishes each commit it carries, and GitHub keeps them after a squash merge, so a served file an
 * earlier commit held - one made before a picture rule was fixed - is public even though the head replaced
 * it. The other gates read only the head. This one walks every commit the pull request adds and hashes each
 * served file version it finds.
 *
 * Run: pnpm check:served-history [range]    (default range: origin/main..HEAD; CI fetches the whole history)
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unlistedServedFiles } from './serve-pdfs-core.mjs';

const MANIFEST = 'content-ops/served-pdfs.json';
const DOCS = 'static/docs';

/** @param {string[]} args */
function gitLines(args) {
	return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 })
		.split('\n')
		.filter(Boolean);
}

/** @param {string} blob */
function gitBlob(blob) {
	return execFileSync('git', ['cat-file', 'blob', blob], { maxBuffer: 1 << 30 });
}

/**
 * Each served file version the commits in `range` hold, once per distinct file.
 *
 * @param {string} range A git revision range.
 * @returns {{commit: string, path: string, sha256: string}[]}
 */
function carriedServedFiles(range) {
	/** @type {Map<string, {commit: string, path: string, sha256: string}>} */
	const seen = new Map();
	for (const commit of gitLines(['rev-list', range])) {
		// Each line: "<mode> blob <object id>\t<path>".
		for (const line of gitLines(['ls-tree', '-r', commit, '--', DOCS])) {
			const [meta, path] = line.split('\t');
			const blob = meta?.split(' ')[2];
			if (blob === undefined || path === undefined || seen.has(blob)) continue;
			const sha256 = createHash('sha256').update(gitBlob(blob)).digest('hex');
			seen.set(blob, { commit, path, sha256 });
		}
	}
	return [...seen.values()];
}

function main() {
	const range = process.argv[2] ?? 'origin/main..HEAD';
	/** @type {{sha256: string}[]} */
	const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
	const listed = new Set(manifest.map((entry) => entry.sha256));
	const carried = carriedServedFiles(range);
	const unlisted = unlistedServedFiles(carried, listed);
	console.log(`[check:served-history] ${carried.length} served file version(s) in ${range}`);
	if (unlisted.length > 0) {
		for (const file of unlisted) console.error(`    ${file.commit.slice(0, 7)} ${file.path}`);
		console.error('    These were never proven. Rebuild the branch so no commit carries them.');
		throw new Error('E_SERVED_HISTORY_UNLISTED');
	}
	console.log('[check:served-history] OK: every one is recorded in the manifest');
}

main();
