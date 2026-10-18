import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { MIN_WORDS } from '../../../content-ops/curate-backup-words-core.mjs';
import { WORDS_V1, WORDS_V1_TEXT, WORDS_V1_SHA256 } from './words-v1';

const REMOVALS_PATH = fileURLToPath(
	new URL('../../../content-ops/backup-words-removed.txt', import.meta.url)
);

const LF = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

// The list is frozen for backup format v1: a changed list could refuse the words of an old backup. This
// literal is the whole point of the test, so it is typed here and never read from the module.
const PINNED_SHA256 = '1cfc49f57b2991e0cd26d170bc091cf924d1c4073fbe734d719350b9de16b0ca';
const REMOVED_COUNT = 147;

describe('the backup word list (format v1)', () => {
	it('carries at least 77 bits for six words', () => {
		expect(WORDS_V1.length).toBeGreaterThanOrEqual(7299);
		expect(WORDS_V1.length).toBeGreaterThanOrEqual(MIN_WORDS);
		expect(6 * Math.log2(WORDS_V1.length)).toBeGreaterThanOrEqual(77);
	});

	it('has the hash of its text as UTF-8, equal to the literal pinned here', () => {
		const actual = createHash('sha256').update(WORDS_V1_TEXT, 'utf8').digest('hex');
		expect(WORDS_V1_SHA256).toBe(actual);
		expect(actual).toBe(PINNED_SHA256);
	});

	it('holds none of the reviewed removals', () => {
		const removed = readFileSync(REMOVALS_PATH, 'utf-8')
			.split(LF)
			.filter((line) => line !== '')
			.map((line) => line.split(TAB)[0] ?? '');
		expect(removed).toHaveLength(REMOVED_COUNT);
		const kept = new Set(WORDS_V1);
		expect(removed.filter((word) => kept.has(word))).toEqual([]);
	});
});
