/**
 * Gate the backup key worker and the word list against their sources.
 *
 * Both are rebuilt here from committed inputs and must match what is committed, byte for byte, so nobody can slip
 * a changed worker or word list into a release. The word list matters most: it is frozen for backup format v1, and
 * a changed list could refuse the words of an old backup, so the source file and the finished list are each pinned
 * by a hash that lives in this file and moves only by a reviewed change to it, and the removal list is held by the
 * rebuild: change one line of it and the list no longer matches.
 *
 * The worker ships as one file in a folder named for its own hash, and the app reads that URL from
 * `src/lib/backup/kdf-paths.ts`. The gate refuses a stray folder or an unchecked file beside it, because the
 * service worker keeps every shipped `/backup-kdf/` path for every visitor, so an unchecked file there would be
 * served and cached with no byte check at all. It compares that file whole, as text, with what the build writes, and never imports app code.
 *
 * Run: pnpm check:backup-vendor
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	KDF_FILE,
	KDF_FOLDER,
	buildWorkerBytes,
	expectedWorkerSrc,
	pathsModule,
	workerHash
} from './backup-kdf-build-core.mjs';
import {
	curateWords,
	parseRemovals,
	parseSource,
	renderWordsModule
} from './curate-backup-words-core.mjs';
import { formatWordsModule } from './curate-backup-words.mjs';

// The EFF Large Wordlist exactly as published, and the finished list's text. A different list could refuse the
// words of an old backup, so a change to either number is a format change, not a refresh.
const EFF_LARGE_SOURCE_SHA256 = 'addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e';
const WORDS_V1_SHA256 = '1cfc49f57b2991e0cd26d170bc091cf924d1c4073fbe734d719350b9de16b0ca';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LF = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
// The line feed as it is written inside a string literal: two characters, not a line break.
const LF_ESCAPE = BACKSLASH + 'n';

// A test points the gate at copies; CI and the build always check the committed files.
const SOURCE_PATH =
	process.env.BACKUP_VENDOR_SOURCE ?? `${ROOT}content-ops/vendor/eff_large_wordlist.txt`;
const REMOVALS_PATH =
	process.env.BACKUP_VENDOR_REMOVALS ?? `${ROOT}content-ops/backup-words-removed.txt`;
const WORDS_PATH = process.env.BACKUP_VENDOR_WORDS ?? `${ROOT}src/lib/backup/words-v1.ts`;
const VENDOR_ROOT = process.env.BACKUP_VENDOR_ROOT ?? `${ROOT}${KDF_FOLDER}`;
const PATHS_FILE = process.env.BACKUP_VENDOR_PATHS ?? `${ROOT}src/lib/backup/kdf-paths.ts`;

/** @param {string | Uint8Array} data */
function sha256(data) {
	return createHash('sha256').update(data).digest('hex');
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
	console.error(`[check:backup-vendor] FAIL: ${message}`);
	process.exit(1);
}

/**
 * The text between the quotes of `export const <name> = '...';`, or null. The formatter may move a long string to
 * the next line, so only whitespace is allowed between the equals sign and the opening quote. The strings read
 * here hold letters, line-feed escapes and hex digits, never a quote.
 * @param {string} source
 * @param {string} name
 * @returns {string | null}
 */
function quotedConstant(source, name) {
	const declaration = `export const ${name} =`;
	const at = source.indexOf(declaration);
	if (at === -1) return null;
	const afterEquals = at + declaration.length;
	const open = source.indexOf("'", afterEquals);
	if (open === -1 || source.slice(afterEquals, open).trim() !== '') return null;
	const close = source.indexOf(`';${LF}`, open + 1);
	return close === -1 ? null : source.slice(open + 1, close);
}

/** @param {string} label @param {string} path */
function readRequired(label, path) {
	if (!existsSync(path)) fail(`${label} is absent (${path}).`);
	return readFileSync(path);
}

async function main() {
	// 1. The EFF source is the real one.
	const sourceBytes = readRequired('The EFF word list source', SOURCE_PATH);
	if (sha256(sourceBytes) !== EFF_LARGE_SOURCE_SHA256) {
		fail(`${SOURCE_PATH} is not the EFF Large Wordlist as published (its SHA-256 differs).`);
	}

	// 2 and 3. The curation, rerun from the source and the removal list, is the committed list.
	/** @type {string} */
	let rebuiltWords;
	try {
		const sourceWords = parseSource(sourceBytes.toString('utf-8'));
		const removed = parseRemovals(
			readRequired('The removal list', REMOVALS_PATH).toString('utf-8'),
			sourceWords
		);
		rebuiltWords = await formatWordsModule(
			renderWordsModule(curateWords(sourceWords, removed)),
			WORDS_PATH
		);
	} catch (error) {
		const code = error instanceof Error ? error.message : 'E_UNKNOWN';
		fail(`the word list cannot be rebuilt from its source and removal list (${code}).`);
	}
	const committedWords = readRequired('The word list module', WORDS_PATH).toString('utf-8');
	if (committedWords !== rebuiltWords) {
		fail(
			`${WORDS_PATH} differs from the list rebuilt from the source and the removal list. ` +
				'Run `pnpm curate:backup-words` and review the change; a changed list is a format change.'
		);
	}
	const text = quotedConstant(committedWords, 'WORDS_V1_TEXT');
	const declared = quotedConstant(committedWords, 'WORDS_V1_SHA256');
	if (text === null || declared === null) fail(`${WORDS_PATH} does not declare its text and hash.`);
	const textHash = sha256(String(text).replaceAll(LF_ESCAPE, LF));
	if (textHash !== declared || textHash !== WORDS_V1_SHA256) {
		fail(`the word list text hashes to ${textHash}, not the pinned ${WORDS_V1_SHA256}.`);
	}

	// 4. The worker, rebuilt.
	const rebuilt = await buildWorkerBytes(ROOT);
	const hash = workerHash(rebuilt);

	// 5. The vendored folder is exactly the one file, under the rebuilt bytes' own hash.
	if (!existsSync(VENDOR_ROOT)) fail(`${VENDOR_ROOT} is absent. Run \`pnpm build:backup-kdf\`.`);
	const stray = readdirSync(VENDOR_ROOT).filter((entry) => entry !== hash);
	if (stray.length > 0) {
		fail(
			`${VENDOR_ROOT} holds more than the rebuilt worker's folder ${hash} (${stray.join(', ')}).`
		);
	}
	const folder = `${VENDOR_ROOT}/${hash}`;
	if (!existsSync(folder)) {
		fail(`${folder} is absent. Run \`pnpm build:backup-kdf\` and commit the result.`);
	}
	const unchecked = readdirSync(folder).filter((entry) => entry !== KDF_FILE);
	if (unchecked.length > 0) {
		fail(`${folder} holds files this gate does not check (${unchecked.join(', ')}). Delete them.`);
	}
	const file = `${folder}/${KDF_FILE}`;
	if (!existsSync(file) || !statSync(file).isFile()) {
		fail(`${file} is absent. Run \`pnpm build:backup-kdf\` and commit the result.`);
	}
	if (Buffer.compare(readFileSync(file), rebuilt) !== 0) {
		fail(`${file} does not match the worker rebuilt from source. Run \`pnpm build:backup-kdf\`.`);
	}

	// 6. The app loads the file it will find.
	// The whole file is compared, not searched: a good export in a comment above a real export of another file would
	// satisfy a search, and the app would load the other file.
	const src = expectedWorkerSrc(hash);
	if (readRequired('The worker URL module', PATHS_FILE).toString('utf-8') !== pathsModule(src)) {
		fail(
			`${PATHS_FILE} is not the file the build writes; it must load ${src} and hold nothing else. ` +
				'Run `pnpm build:backup-kdf`.'
		);
	}

	console.log(`[check:backup-vendor] OK: worker ${hash} and the word list match their sources`);
}

main().catch((error) => {
	console.error(
		`[check:backup-vendor] FAIL: ${error instanceof Error ? error.message : 'E_UNKNOWN'}`
	);
	process.exit(1);
});
