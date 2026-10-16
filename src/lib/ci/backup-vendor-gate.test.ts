import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KDF_WORKER_SRC } from '$lib/backup/kdf-paths';
import {
	curateWords,
	parseRemovals,
	parseSource,
	renderWordsModule
} from '../../../content-ops/curate-backup-words-core.mjs';
import { formatWordsModule } from '../../../content-ops/curate-backup-words.mjs';

// The vendor gate rebuilds the backup key worker and the word list from source and refuses any difference, so a
// changed worker or list cannot slip into a release. Each case runs the real gate as a child process against
// copies of its inputs, changes one thing, and expects that thing named in the failure.
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const HASH = KDF_WORKER_SRC.split('/')[2] ?? '';
const FILE = 'backup-kdf.worker.mjs';
const GATE_TIMEOUT = 60_000;

type Copies = {
	source: string;
	removals: string;
	words: string;
	vendor: string;
	paths: string;
};

function runGate(copies: Copies) {
	return spawnSync(
		process.execPath,
		['node_modules/tsx/dist/cli.mjs', 'content-ops/check-backup-vendor.mjs'],
		{
			env: {
				...process.env,
				BACKUP_VENDOR_SOURCE: copies.source,
				BACKUP_VENDOR_REMOVALS: copies.removals,
				BACKUP_VENDOR_WORDS: copies.words,
				BACKUP_VENDOR_ROOT: copies.vendor,
				BACKUP_VENDOR_PATHS: copies.paths
			},
			encoding: 'utf8'
		}
	);
}

describe('backup vendor gate', () => {
	let root = '';

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'backup-vendor-'));
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** A full set of copies of the committed inputs, each case in its own folder. */
	function copies(name: string): Copies {
		const base = join(root, name);
		const folder = join(base, 'vendor', HASH);
		mkdirSync(folder, { recursive: true });
		copyFileSync(join('static/backup-kdf', HASH, FILE), join(folder, FILE));
		const made: Copies = {
			source: join(base, 'eff_large_wordlist.txt'),
			removals: join(base, 'backup-words-removed.txt'),
			words: join(base, 'words-v1.ts'),
			vendor: join(base, 'vendor'),
			paths: join(base, 'kdf-paths.ts')
		};
		copyFileSync('content-ops/vendor/eff_large_wordlist.txt', made.source);
		copyFileSync('content-ops/backup-words-removed.txt', made.removals);
		copyFileSync('src/lib/backup/words-v1.ts', made.words);
		copyFileSync('src/lib/backup/kdf-paths.ts', made.paths);
		return made;
	}

	/** Rewrite a copied file through a text change, and prove the change took effect. */
	function edit(path: string, change: (text: string) => string) {
		const before = readFileSync(path, 'utf8');
		const after = change(before);
		expect(after).not.toBe(before);
		writeFileSync(path, after);
	}

	function expectRefusal(copy: Copies, message: string) {
		const result = runGate(copy);
		expect(result.status, result.stdout).toBe(1);
		expect(result.stderr).toContain(message);
	}

	it(
		'passes the committed worker, word list and URL',
		() => {
			const result = runGate(copies('exact'));
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain(HASH);
		},
		GATE_TIMEOUT
	);

	it(
		'refuses a source file with one byte changed',
		() => {
			const copy = copies('source');
			edit(copy.source, (text) => text.replace('abacus', 'abacux'));
			expectRefusal(copy, 'is not the EFF Large Wordlist as published');
		},
		GATE_TIMEOUT
	);

	it(
		'refuses a removal list with a line removed',
		() => {
			const copy = copies('removal-line');
			edit(copy.removals, (text) => {
				const lines = text.split(LF);
				const drug = lines.findIndex((line) => line.endsWith(`${TAB}drug`));
				return lines.filter((_, index) => index !== drug).join(LF);
			});
			expectRefusal(copy, 'differs from the list rebuilt from the source and the removal list');
		},
		GATE_TIMEOUT
	);

	it(
		'refuses a removal list that no longer removes a hyphenated word',
		() => {
			const copy = copies('removal-hyphen');
			edit(copy.removals, (text) =>
				text
					.split(LF)
					.filter((line) => !line.endsWith(`${TAB}hyphen`))
					.join(LF)
			);
			expectRefusal(copy, 'E_CURATED_NOT_LETTERS');
		},
		GATE_TIMEOUT
	);

	it(
		'refuses a removal-list word that is not in the source',
		() => {
			const copy = copies('removal-typo');
			edit(copy.removals, (text) => `zzzzzzzz${TAB}drug${LF}${text}`);
			expectRefusal(copy, 'E_REMOVAL_UNKNOWN_WORD');
		},
		GATE_TIMEOUT
	);

	it(
		'refuses a second folder beside the worker folder',
		() => {
			const copy = copies('stray-folder');
			mkdirSync(join(copy.vendor, '0000000000000000'));
			writeFileSync(join(copy.vendor, '0000000000000000', FILE), 'x');
			expectRefusal(copy, '0000000000000000');
		},
		GATE_TIMEOUT
	);

	it(
		'refuses a file in the worker folder that it does not check',
		() => {
			const copy = copies('extra-file');
			writeFileSync(join(copy.vendor, HASH, 'extra.mjs'), 'x');
			expectRefusal(copy, 'extra.mjs');
		},
		GATE_TIMEOUT
	);

	it(
		'refuses worker bytes that differ under the same folder name',
		() => {
			const copy = copies('changed-bytes');
			appendFileSync(join(copy.vendor, HASH, FILE), ';');
			expectRefusal(copy, 'does not match the worker rebuilt from source');
			expect(readdirSync(copy.vendor)).toEqual([HASH]);
		},
		GATE_TIMEOUT
	);

	it(
		'refuses a URL that names another hash',
		() => {
			const copy = copies('other-hash');
			edit(copy.paths, (text) => text.replace(HASH, '0000000000000000'));
			expectRefusal(copy, `it must load /backup-kdf/${HASH}/${FILE}`);
		},
		GATE_TIMEOUT
	);

	it(
		'refuses a word list module that is not formatted as the curation formats it',
		() => {
			const copy = copies('unformatted');
			// The same words on the same constant, joined onto one line the way prettier would not leave them.
			edit(copy.words, (text) => text.replace(`WORDS_V1_TEXT =${LF}${TAB}'`, "WORDS_V1_TEXT = '"));
			expectRefusal(copy, 'differs from the list rebuilt from the source and the removal list');
		},
		GATE_TIMEOUT
	);

	// The list is frozen for backup format v1. A change to the removal list that is carried all the way through
	// (the list regenerated, formatted and committed with it) agrees with itself everywhere, so only the hash
	// pinned inside the gate can stop it.
	it(
		'refuses a regenerated list whose text is not the pinned one',
		async () => {
			const copy = copies('regenerated');
			edit(copy.removals, (text) => `abacus${TAB}drug${LF}${text}`);
			const sourceWords = parseSource(readFileSync(copy.source, 'utf8'));
			const removed = parseRemovals(readFileSync(copy.removals, 'utf8'), sourceWords);
			const regenerated = renderWordsModule(curateWords(sourceWords, removed));
			writeFileSync(copy.words, await formatWordsModule(regenerated, copy.words));
			expectRefusal(copy, 'not the pinned');
		},
		GATE_TIMEOUT
	);
});
