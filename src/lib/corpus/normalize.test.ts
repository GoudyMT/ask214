import { describe, it, expect } from 'vitest';
import { normalizeText } from './normalize';

// Non-ASCII inputs are built from code points so the source stays pure ASCII and the bytes are explicit
// (the NFC case must feed a DECOMPOSED sequence, not an editor-normalized precomposed char).
const NBSP = String.fromCodePoint(0x00a0);
const ZWSP = String.fromCodePoint(0x200b);
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
const BOM = String.fromCodePoint(0xfeff);
const FI = String.fromCodePoint(0xfb01); // fi ligature
const FL = String.fromCodePoint(0xfb02); // fl ligature
const FFI = String.fromCodePoint(0xfb03); // ffi ligature

describe('normalizeText', () => {
	it('collapses all whitespace (incl. NBSP) to single spaces and trims', () => {
		expect(normalizeText('  a\t b  c \n d  ')).toBe('a b c d');
		expect(normalizeText('a' + NBSP + NBSP + 'b')).toBe('a b');
	});

	it('expands Latin ligatures to ASCII', () => {
		expect(normalizeText('e' + FFI + 'cient ' + FI + 'le ' + FL + 'ow')).toBe(
			'efficient file flow'
		);
	});

	it('strips zero-width chars, BOM, and soft hyphens', () => {
		expect(normalizeText('wo' + ZWSP + 'rd' + SOFT_HYPHEN + 's' + BOM)).toBe('words');
	});

	it('joins line-break hyphenation', () => {
		expect(normalizeText('inter-\nnational')).toBe('international');
	});

	it('applies NFC (decomposed combining mark -> precomposed)', () => {
		expect(normalizeText(String.fromCodePoint(0x65, 0x0301))).toBe(String.fromCodePoint(0x00e9));
	});

	it('is idempotent (running it twice equals running it once)', () => {
		const messy = 'The VA' + FI + 'led  the' + SOFT_HYPHEN + ' form-\nwork.';
		expect(normalizeText(normalizeText(messy))).toBe(normalizeText(messy));
	});
});
