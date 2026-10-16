import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check, resolveConfig } from 'prettier';
import { describe, it, expect } from 'vitest';
import {
	parseSource,
	parseRemovals,
	curateWords,
	renderWordsModule,
	MIN_WORDS
} from '../../../content-ops/curate-backup-words-core.mjs';
import { formatWordsModule } from '../../../content-ops/curate-backup-words.mjs';
import { WORDS_V1, WORDS_V1_TEXT, WORDS_V1_SHA256 } from './words-v1';

const MODULE_PATH = fileURLToPath(new URL('./words-v1.ts', import.meta.url));
const SOURCE_PATH = fileURLToPath(
	new URL('../../../content-ops/vendor/eff_large_wordlist.txt', import.meta.url)
);
const REMOVALS_PATH = fileURLToPath(
	new URL('../../../content-ops/backup-words-removed.txt', import.meta.url)
);

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

// The list is frozen for backup format v1: a changed list could refuse the words of an old backup. This
// literal is the whole point of the test, so it is typed here and never read from the module.
const PINNED_SHA256 = '1cfc49f57b2991e0cd26d170bc091cf924d1c4073fbe734d719350b9de16b0ca';
const PINNED_COUNT = 7629;
const REMOVED_COUNT = 147;

describe('the backup word list (format v1)', () => {
	it('has exactly 7629 words', () => {
		expect(WORDS_V1).toHaveLength(PINNED_COUNT);
		expect(PINNED_COUNT).toBe(7776 - REMOVED_COUNT);
	});

	it('carries at least 77 bits for six words', () => {
		expect(WORDS_V1.length).toBeGreaterThanOrEqual(7299);
		expect(WORDS_V1.length).toBeGreaterThanOrEqual(MIN_WORDS);
		expect(6 * Math.log2(WORDS_V1.length)).toBeGreaterThanOrEqual(77);
	});

	it('holds only lowercase letters in every word', () => {
		expect(WORDS_V1.filter((word) => !/^[a-z]+$/.test(word))).toEqual([]);
	});

	it('has no repeated word', () => {
		expect(new Set(WORDS_V1).size).toBe(WORDS_V1.length);
	});

	it('is sorted by code unit', () => {
		const sorted = [...WORDS_V1].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		expect(WORDS_V1).toEqual(sorted);
	});

	it('has a text with no byte-order mark, no carriage return and no trailing line feed', () => {
		expect(WORDS_V1_TEXT.startsWith(BYTE_ORDER_MARK)).toBe(false);
		expect(WORDS_V1_TEXT.includes(CR)).toBe(false);
		expect(WORDS_V1_TEXT.endsWith(LF)).toBe(false);
		expect(WORDS_V1_TEXT.split(LF)).toEqual([...WORDS_V1]);
	});

	it('has the hash of its text as UTF-8, equal to the literal pinned here', () => {
		const actual = createHash('sha256').update(WORDS_V1_TEXT, 'utf8').digest('hex');
		expect(WORDS_V1_SHA256).toBe(actual);
		expect(actual).toBe(PINNED_SHA256);
	});

	it('is frozen', () => {
		expect(Object.isFrozen(WORDS_V1)).toBe(true);
		expect(() => (WORDS_V1 as string[]).push('extra')).toThrow(TypeError);
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

	it('passes prettier --check', async () => {
		const config = await resolveConfig(MODULE_PATH);
		const ok = await check(readFileSync(MODULE_PATH, 'utf-8'), {
			...config,
			filepath: MODULE_PATH
		});
		expect(ok).toBe(true);
	});

	it('is what rebuilding from the committed source and removals gives, byte for byte', async () => {
		const sourceWords = parseSource(readFileSync(SOURCE_PATH, 'utf-8'));
		const removed = parseRemovals(readFileSync(REMOVALS_PATH, 'utf-8'), sourceWords);
		const rebuilt = await formatWordsModule(
			renderWordsModule(curateWords(sourceWords, removed)),
			MODULE_PATH
		);
		expect(rebuilt).toBe(readFileSync(MODULE_PATH, 'utf-8'));
	});
});
