/**
 * Build the backup key worker as one file under a folder named for its own hash, and point the app at it.
 *
 * The file is served from the app's own origin and kept in the offline cache for every visitor, so a person
 * can make or open a backup with no connection, even right after "Erase all data". The hash is in the folder
 * name because a cached file at a fixed URL is served forever: new bytes need a new URL, or a returning
 * device would run an old worker against a new page. The build is byte-reproducible, and
 * `pnpm check:backup-vendor` rebuilds it in CI and refuses any difference.
 *
 * Run: pnpm build:backup-kdf
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	KDF_FILE,
	KDF_FOLDER,
	buildWorkerBytes,
	expectedWorkerSrc,
	pathsModule,
	workerHash
} from './backup-kdf-build-core.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PATHS_FILE = join(ROOT, 'src/lib/backup/kdf-paths.ts');

async function main() {
	const bytes = await buildWorkerBytes(ROOT);
	const hash = workerHash(bytes);
	const vendorRoot = join(ROOT, KDF_FOLDER);
	mkdirSync(vendorRoot, { recursive: true });
	for (const entry of readdirSync(vendorRoot)) {
		if (entry !== hash) rmSync(join(vendorRoot, entry), { recursive: true, force: true });
	}
	const target = join(vendorRoot, hash, KDF_FILE);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, bytes);
	writeFileSync(PATHS_FILE, pathsModule(expectedWorkerSrc(hash)));
	console.log(`[build:backup-kdf] wrote ${KDF_FOLDER}/${hash}/${KDF_FILE} (${bytes.length} bytes)`);
}

// Importing this file must not write anything.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(
			`[build:backup-kdf] FAIL: ${error instanceof Error ? error.message : 'E_UNKNOWN'}`
		);
		process.exit(1);
	});
}
