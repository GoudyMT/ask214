import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIBRARY_BYTES, LIBRARY_SRC, WORKER_SRC } from '$lib/sources/pdf-library-paths';

// The pdf-worker gate compares the vendored library and worker with the installed package. It must also
// refuse any file in the release folder that it does not check: the service worker restores every shipped
// /pdf-worker/ path to a device holding saved documents, so an unchecked file there would be served and
// cached with no byte check at all. The gate runs for real, against copies of the folder.
const VERSION = JSON.parse(readFileSync('node_modules/pdfjs-dist/package.json', 'utf8')).version;
const FILES = ['pdf.min.mjs', 'pdf.worker.min.mjs'];
const GATE_TIMEOUT = 30_000;

function runGate(vendorRoot: string) {
	return spawnSync(
		process.execPath,
		['node_modules/tsx/dist/cli.mjs', 'content-ops/check-pdf-worker.mjs'],
		{ env: { ...process.env, PDF_VENDOR_ROOT: vendorRoot }, encoding: 'utf8' }
	);
}

describe('pdf-worker gate', () => {
	let root = '';

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'pdf-vendor-'));
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function vendorCopy(name: string, extra: string[]): string {
		const folder = join(root, name, VERSION);
		mkdirSync(folder, { recursive: true });
		for (const file of FILES) {
			copyFileSync(join('static/pdf-worker', VERSION, file), join(folder, file));
		}
		for (const file of extra) writeFileSync(join(folder, file), 'x');
		return join(root, name);
	}

	it(
		'passes a release folder holding exactly the vendored files',
		() => {
			const result = runGate(vendorCopy('exact', []));
			expect(result.status, result.stderr).toBe(0);
		},
		GATE_TIMEOUT
	);

	it(
		'refuses a release folder holding a file it does not check',
		() => {
			const result = runGate(vendorCopy('stray', ['openjpeg.wasm']));
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('openjpeg.wasm');
		},
		GATE_TIMEOUT
	);
});

// The Save area states what a first save downloads, the page reader included, so the size it states must be the
// vendored files' real size. A new release of the library changes it, and this fails until it is stated again.
describe('LIBRARY_BYTES', () => {
	it('is the size of the vendored library and its worker on disk', () => {
		const onDisk = [LIBRARY_SRC, WORKER_SRC].reduce(
			(sum, path) => sum + statSync(`static${path}`).size,
			0
		);
		expect(LIBRARY_BYTES).toBe(onDisk);
	});
});
