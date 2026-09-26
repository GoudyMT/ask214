/**
 * Gate the vendored PDF library and worker against the installed package.
 *
 * The library refuses to run against a worker built from a different release, so a dependency bump that
 * does not re-copy these files turns into a runtime failure the moment a reader opens - with nothing failing
 * at build time to warn anyone. This is the check that makes vendoring safe rather than a trap.
 *
 * Both are vendored, instead of emitted by the bundler, so they live in their own served namespace and the
 * service worker can treat them as lazy. An emitted file lands under the immutable build namespace, where
 * install would precache it for every visitor and one failed fetch would fail the whole install.
 *
 * They sit in a folder named for the release, because a cached file at a fixed URL is served forever: a new
 * release must arrive at a new URL, or a returning user gets a new library with an old cached worker. So the
 * gate checks the folder name and the runtime's URLs as well as the bytes, and refuses a leftover folder
 * from an earlier release. It also refuses any file in the release folder that it does not check: the service
 * worker restores every shipped `/pdf-worker/` path to a device holding saved documents, so an unchecked file
 * there would be served and cached with no byte check at all.
 *
 * Run: pnpm check:pdf-worker
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { LIBRARY_SRC, WORKER_SRC } from '../src/lib/sources/pdf-runtime.ts';

const PACKAGE = 'node_modules/pdfjs-dist';
// A test points the gate at a copy of the folder; CI and the build always check the committed one.
const VENDOR_ROOT = process.env.PDF_VENDOR_ROOT ?? 'static/pdf-worker';
const FILES = ['pdf.min.mjs', 'pdf.worker.min.mjs'];

/** @param {string} path */
function digest(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** @param {string} message */
function fail(message) {
	console.error(`[check:pdf-worker] FAIL: ${message}`);
	process.exit(1);
}

function main() {
	if (!existsSync(`${PACKAGE}/package.json`)) fail(`${PACKAGE} is absent. Run \`pnpm install\`.`);
	const version = JSON.parse(readFileSync(`${PACKAGE}/package.json`, 'utf-8')).version;
	const folder = `${VENDOR_ROOT}/${version}`;

	for (const name of FILES) {
		const vendored = `${folder}/${name}`;
		const installed = `${PACKAGE}/build/${name}`;
		if (!existsSync(vendored)) {
			fail(`${vendored} is absent. Copy ${installed} there and commit it.`);
		}
		if (digest(vendored) !== digest(installed)) {
			fail(`${vendored} does not match the installed package. Copy ${installed} over it.`);
		}
	}

	const unchecked = readdirSync(folder).filter((entry) => !FILES.includes(entry));
	if (unchecked.length > 0) {
		fail(`${folder} holds files this gate does not check (${unchecked.join(', ')}). Delete them.`);
	}

	const stray = readdirSync(VENDOR_ROOT).filter((entry) => entry !== version);
	if (stray.length > 0) {
		fail(`${VENDOR_ROOT} holds more than the installed release (${stray.join(', ')}). Delete it.`);
	}

	const expected = {
		library: `/pdf-worker/${version}/pdf.min.mjs`,
		worker: `/pdf-worker/${version}/pdf.worker.min.mjs`
	};
	if (LIBRARY_SRC !== expected.library || WORKER_SRC !== expected.worker) {
		fail(
			`src/lib/sources/pdf-runtime.ts loads ${LIBRARY_SRC} and ${WORKER_SRC}; it must load ` +
				`${expected.library} and ${expected.worker}.`
		);
	}

	console.log(`[check:pdf-worker] OK: vendored library and worker match pdfjs-dist ${version}`);
}

main();
