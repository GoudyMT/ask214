/**
 * Build the backup word list: the EFF Large Wordlist minus the reviewed removals, written as a TypeScript
 * module the key worker will import.
 *
 * The list is made by a script from two committed files, so anyone can rebuild it and get the same bytes;
 * a hash in the module pins it, and a test rebuilds it and compares. A changed list could refuse the words
 * of an old backup, so the output is frozen for backup format v1 and a new list ships only with a new
 * format version.
 *
 * The module is formatted with the repo's prettier config, so the committed bytes are what the commit
 * hook's `prettier --write` would leave and a later format run never makes a diff in a generated file.
 *
 * Run: pnpm curate:backup-words
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
	parseSource,
	parseRemovals,
	curateWords,
	renderWordsModule
} from './curate-backup-words-core.mjs';

const SOURCE_PATH = fileURLToPath(new URL('./vendor/eff_large_wordlist.txt', import.meta.url));
const REMOVALS_PATH = fileURLToPath(new URL('./backup-words-removed.txt', import.meta.url));
const WORDS_MODULE_PATH = fileURLToPath(new URL('../src/lib/backup/words-v1.ts', import.meta.url));

/**
 * Format the module source with the repo's prettier config.
 *
 * The config is looked up from the module's place in the repo, not from `target`: a test points `target`
 * at a folder outside the repo, where no config is found and the bytes would come out unformatted.
 * `target` only tells prettier which parser to use.
 * @param {string} source
 * @param {string} target
 * @returns {Promise<string>}
 */
export async function formatWordsModule(source, target) {
	const config = await resolveConfig(WORDS_MODULE_PATH);
	return format(source, { ...config, filepath: target });
}

async function main() {
	// A test points the output at a scratch file; the committed module is always written by a plain run.
	const target = process.env.BACKUP_WORDS_OUT ?? WORDS_MODULE_PATH;
	console.log(`[1/3] reading ${SOURCE_PATH} and ${REMOVALS_PATH}`);
	const sourceWords = parseSource(readFileSync(SOURCE_PATH, 'utf-8'));
	const removed = parseRemovals(readFileSync(REMOVALS_PATH, 'utf-8'), sourceWords);
	console.log(`[1/3] ${sourceWords.length} source words, ${removed.size} reviewed removals`);
	console.log('[2/3] curating');
	const words = curateWords(sourceWords, removed);
	console.log(`[2/3] ${words.length} words kept`);
	console.log('[3/3] rendering and formatting');
	const formatted = await formatWordsModule(renderWordsModule(words), target);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, formatted);
	console.log(`[3/3] wrote ${words.length} words to ${target}`);
}

// Importing this file (the rebuild test does) must not write anything.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(
			`[curate:backup-words] FAIL: ${error instanceof Error ? error.message : 'E_UNKNOWN'}`
		);
		process.exit(1);
	});
}
