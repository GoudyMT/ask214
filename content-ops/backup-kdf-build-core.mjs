/**
 * The one recipe for the backup key worker's bytes, shared by the build script and the CI gate so the two can
 * never disagree about how the file is made or what it is called.
 *
 * Every option is fixed here and nothing about the machine reaches the output (no absolute path, no date, no
 * `define`), so the same source and the same esbuild release give the same bytes on any computer. The gate
 * rebuilds the file from source and compares it with the committed copy, which is what stops a changed worker
 * or word list from slipping into a release.
 */

import { createHash } from 'node:crypto';
import { build } from 'esbuild';

export const KDF_FOLDER = 'static/backup-kdf';
export const KDF_FILE = 'backup-kdf.worker.mjs';

const ENTRY = 'src/lib/backup/worker/entry.ts';
const HASH_LENGTH = 16;

/**
 * Bundle the worker entry in memory.
 * @param {string} root the repository folder the entry path is resolved from
 * @returns {Promise<Uint8Array>} the bytes of the single output file
 */
export async function buildWorkerBytes(root) {
	const result = await build({
		entryPoints: [ENTRY],
		absWorkingDir: root,
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: true,
		sourcemap: false,
		// Keeps the notices of the bundled MIT code in the shipped file.
		legalComments: 'eof',
		write: false,
		logLevel: 'silent'
	});
	const [file, ...others] = result.outputFiles;
	if (file === undefined || others.length > 0) throw new Error('E_KDF_BUILD_OUTPUT');
	return file.contents;
}

/**
 * The first 16 lowercase hex characters of the bytes' SHA-256: the folder name the file is served from.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function workerHash(bytes) {
	return createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LENGTH);
}

/**
 * The URL the app loads the worker from, for a given hash.
 * @param {string} hash
 * @returns {string}
 */
export function expectedWorkerSrc(hash) {
	return `/backup-kdf/${hash}/${KDF_FILE}`;
}
