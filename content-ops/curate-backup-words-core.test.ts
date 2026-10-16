import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
	REMOVAL_REASONS,
	MIN_WORDS,
	SOURCE_LINES,
	parseSource,
	parseRemovals,
	curateWords,
	renderWordsModule
} from './curate-backup-words-core.mjs';

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BACKSLASH = String.fromCharCode(92);

// The dice index of line i: five digits, each 1-6, counting up in base six.
function diceIndex(i: number): string {
	return [...i.toString(6).padStart(5, '0')].map((digit) => String(Number(digit) + 1)).join('');
}

function sourceOf(words: readonly string[]): string {
	return words.map((word, i) => `${diceIndex(i)}${TAB}${word}${LF}`).join('');
}

function removalsOf(...rows: readonly (readonly [string, string])[]): string {
	return rows.map(([word, reason]) => `${word}${TAB}${reason}${LF}`).join('');
}

// Distinct all-letter words: "aaa", "aab", ... (26 cubed is more than the bound needs).
function lettersOnly(count: number): string[] {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz';
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		out.push(
			alphabet.charAt(Math.floor(i / 676) % 26) +
				alphabet.charAt(Math.floor(i / 26) % 26) +
				alphabet.charAt(i % 26)
		);
	}
	return out;
}

// A small list is below the real bound, so the cases that are not about the bound lower it to zero.
const NO_BOUND = 0;

describe('constants', () => {
	it('names the six removal reasons, frozen', () => {
		expect([...REMOVAL_REASONS]).toEqual([
			'hyphen',
			'alternate',
			'brand',
			'drug',
			'proper',
			'offensive'
		]);
		expect(Object.isFrozen(REMOVAL_REASONS)).toBe(true);
	});

	it('pins the bound that keeps six words at 77 bits, and the source length', () => {
		expect(MIN_WORDS).toBe(7299);
		expect(6 * Math.log2(MIN_WORDS)).toBeGreaterThanOrEqual(77);
		expect(6 * Math.log2(MIN_WORDS - 1)).toBeLessThan(77);
		expect(SOURCE_LINES).toBe(7776);
	});
});

describe('parseSource', () => {
	it('returns the words in file order', () => {
		expect(parseSource(sourceOf(['zebra', 'abacus', 't-shirt']), 3)).toEqual([
			'zebra',
			'abacus',
			't-shirt'
		]);
	});

	it('wants the real line count unless told otherwise', () => {
		expect(() => parseSource(sourceOf(['abacus', 'abdomen', 'abdominal']))).toThrow(
			'E_SOURCE_SHAPE'
		);
	});

	it('refuses the wrong number of lines', () => {
		expect(() => parseSource(sourceOf(['abacus', 'abdomen']), 3)).toThrow('E_SOURCE_SHAPE');
		expect(() => parseSource(sourceOf(['abacus', 'abdomen', 'abdominal', 'abide']), 3)).toThrow(
			'E_SOURCE_SHAPE'
		);
	});

	it('refuses a carriage return', () => {
		const text = sourceOf(['abacus', 'abdomen', 'abdominal']).replace(LF, CR + LF);
		expect(() => parseSource(text, 3)).toThrow('E_SOURCE_SHAPE');
	});

	it('refuses a missing final line feed', () => {
		const text = sourceOf(['abacus', 'abdomen', 'abdominal']).slice(0, -1);
		expect(() => parseSource(text, 3)).toThrow('E_SOURCE_SHAPE');
	});

	it('refuses a blank line at the end', () => {
		expect(() => parseSource(sourceOf(['abacus', 'abdomen', 'abdominal']) + LF, 3)).toThrow(
			'E_SOURCE_SHAPE'
		);
	});

	it('refuses an index that is not five digits of 1 to 6', () => {
		const rows = ['11111', '11117', '11113'];
		const words = ['abacus', 'abdomen', 'abdominal'];
		const text = rows.map((row, i) => `${row}${TAB}${words[i]}${LF}`).join('');
		expect(() => parseSource(text, 3)).toThrow('E_SOURCE_SHAPE');
		expect(() => parseSource(`1111${TAB}abacus${LF}`, 1)).toThrow('E_SOURCE_SHAPE');
	});

	it('refuses a line without exactly one tab before the word', () => {
		expect(() => parseSource(`11111 abacus${LF}`, 1)).toThrow('E_SOURCE_SHAPE');
		expect(() => parseSource(`11111${TAB}${TAB}abacus${LF}`, 1)).toThrow('E_SOURCE_SHAPE');
		expect(() => parseSource(`11111${TAB}${LF}`, 1)).toThrow('E_SOURCE_SHAPE');
	});

	it('refuses a repeated word', () => {
		expect(() => parseSource(sourceOf(['abacus', 'abdomen', 'abacus']), 3)).toThrow(
			'E_SOURCE_SHAPE'
		);
	});

	it('refuses an empty file', () => {
		expect(() => parseSource('', 1)).toThrow('E_SOURCE_SHAPE');
	});
});

describe('parseRemovals', () => {
	const source = ['abacus', 'abdomen', 't-shirt', 'zebra'];

	it('returns the set of removed words', () => {
		const text = removalsOf(['t-shirt', 'hyphen'], ['abdomen', 'drug']);
		expect(parseRemovals(text, source)).toEqual(new Set(['t-shirt', 'abdomen']));
	});

	it('accepts every named reason', () => {
		const rows = REMOVAL_REASONS.map((reason, i) => [`w${i}`, reason] as const);
		const words = rows.map(([word]) => word);
		expect(parseRemovals(removalsOf(...rows), words).size).toBe(6);
	});

	it('refuses an unknown reason', () => {
		expect(() => parseRemovals(removalsOf(['abacus', 'boring']), source)).toThrow(
			'E_REMOVAL_REASON'
		);
	});

	it('refuses a word that is not in the source, so a typo fails', () => {
		expect(() => parseRemovals(removalsOf(['abacuss', 'drug']), source)).toThrow(
			'E_REMOVAL_UNKNOWN_WORD'
		);
	});

	it('refuses a word listed twice', () => {
		const text = removalsOf(['abacus', 'drug'], ['abacus', 'brand']);
		expect(() => parseRemovals(text, source)).toThrow('E_REMOVAL_DUPLICATE');
	});

	it('refuses a line with no tab', () => {
		expect(() => parseRemovals(`abacus drug${LF}`, source)).toThrow('E_REMOVAL_SHAPE');
	});

	it('refuses a line with two tabs', () => {
		expect(() => parseRemovals(`abacus${TAB}drug${TAB}x${LF}`, source)).toThrow('E_REMOVAL_SHAPE');
	});

	it('refuses a carriage return, a missing final line feed and a blank line', () => {
		expect(() => parseRemovals(`abacus${TAB}drug${CR}${LF}`, source)).toThrow('E_REMOVAL_SHAPE');
		expect(() => parseRemovals(`abacus${TAB}drug`, source)).toThrow('E_REMOVAL_SHAPE');
		expect(() => parseRemovals(removalsOf(['abacus', 'drug']) + LF, source)).toThrow(
			'E_REMOVAL_SHAPE'
		);
		expect(() => parseRemovals('', source)).toThrow('E_REMOVAL_SHAPE');
	});
});

describe('curateWords', () => {
	it('drops exactly the removed words and sorts the rest', () => {
		const source = ['pear', 'apple', 'zoo', 'mango', 'kiwi', 'fig'];
		expect(curateWords(source, new Set(['kiwi']), NO_BOUND)).toEqual([
			'apple',
			'fig',
			'mango',
			'pear',
			'zoo'
		]);
	});

	it('puts a word before the longer words it begins', () => {
		expect(curateWords(['b', 'ab', 'a'], new Set(), NO_BOUND)).toEqual(['a', 'ab', 'b']);
	});

	it('does not change the source it was given', () => {
		const source = ['b', 'a'];
		curateWords(source, new Set(), NO_BOUND);
		expect(source).toEqual(['b', 'a']);
	});

	it('refuses a hyphenated word that was left in', () => {
		expect(() => curateWords(['apple', 't-shirt'], new Set(), NO_BOUND)).toThrow(
			'E_CURATED_NOT_LETTERS'
		);
	});

	it('refuses capitals, digits and an empty word', () => {
		expect(() => curateWords(['Apple'], new Set(), NO_BOUND)).toThrow('E_CURATED_NOT_LETTERS');
		expect(() => curateWords(['app1e'], new Set(), NO_BOUND)).toThrow('E_CURATED_NOT_LETTERS');
		expect(() => curateWords([''], new Set(), NO_BOUND)).toThrow('E_CURATED_NOT_LETTERS');
	});

	it('refuses a list shorter than the bound', () => {
		expect(() => curateWords(lettersOnly(10), new Set())).toThrow('E_TOO_FEW_WORDS');
	});

	it('accepts a list exactly at the bound and refuses one word fewer', () => {
		const words = lettersOnly(MIN_WORDS);
		expect(curateWords(words, new Set())).toHaveLength(MIN_WORDS);
		expect(() => curateWords(words, new Set([words[0] ?? '']))).toThrow('E_TOO_FEW_WORDS');
	});
});

describe('renderWordsModule', () => {
	const words = ['apple', 'fig', 'zoo'];
	const rendered = renderWordsModule(words);
	const quoted = /export const WORDS_V1_TEXT = '([^']*)';/.exec(rendered)?.[1] ?? '';
	const text = quoted.split(BACKSLASH + 'n').join(LF);

	it('holds the words as one string joined by an escaped line feed, with no trailing one', () => {
		expect(quoted).toBe(['apple', 'fig', 'zoo'].join(BACKSLASH + 'n'));
		expect(text).toBe('apple' + LF + 'fig' + LF + 'zoo');
		expect(quoted.endsWith(BACKSLASH + 'n')).toBe(false);
		expect(text.endsWith(LF)).toBe(false);
	});

	it('writes the line feed as the two-character escape, never a real line break inside the string', () => {
		const line = rendered.split(LF).find((l) => l.startsWith('export const WORDS_V1_TEXT'));
		expect(line).toBe(`export const WORDS_V1_TEXT = '${quoted}';`);
	});

	it('pins the hash of the text as UTF-8', () => {
		const expected = createHash('sha256').update(text, 'utf8').digest('hex');
		expect(rendered).toContain(`export const WORDS_V1_SHA256 = '${expected}';`);
	});

	it('exports the frozen list split on the same escape', () => {
		expect(rendered).toContain(
			`export const WORDS_V1: readonly string[] = Object.freeze(WORDS_V1_TEXT.split('${BACKSLASH}n'));`
		);
	});

	it('carries the generated-file docblock with the source, licence and freeze rule', () => {
		const head = rendered.slice(0, rendered.indexOf('export const'));
		expect(head).toContain('pnpm curate:backup-words');
		expect(head).toContain('https://www.eff.org/dice');
		expect(head).toContain('CC BY 4.0');
		expect(head).toContain('eff.org/copyright');
		expect(head).toContain('content-ops/backup-words-removed.txt');
		expect(head).toContain('Do not edit by hand');
		expect(head).toContain('Frozen for backup format v1');
	});

	it('refuses a word that is not plain letters, which would break the string', () => {
		expect(() => renderWordsModule(["it's"])).toThrow('E_CURATED_NOT_LETTERS');
		expect(() => renderWordsModule(['t-shirt'])).toThrow('E_CURATED_NOT_LETTERS');
	});

	it('is deterministic', () => {
		expect(renderWordsModule(words)).toBe(rendered);
	});
});
