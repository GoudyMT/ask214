import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizePhrase, compareTypedBack, parseCanonicalBytes } from './phrase';

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const NBSP = String.fromCharCode(160);
const ZWSP = String.fromCharCode(0x200b);
const KELVIN = String.fromCharCode(0x212a);
const FULL_WIDTH_APPLE = String.fromCodePoint(0xff41, 0xff50, 0xff50, 0xff4c, 0xff45);

const PLAIN = 'apple harbor cable dog echo fox';
const SHOWN = ['apple', 'harbor', 'cable', 'dog', 'echo', 'fox'] as const;

function bytesOf(result: ReturnType<typeof canonicalizePhrase>): Uint8Array {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error('phrase was not accepted');
	return result.bytes;
}

function textOf(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('canonicalizePhrase', () => {
	it('canonical form folds case and whitespace', () => {
		const messy = 'Apple  HARBOR' + TAB + 'cable' + NBSP + 'dog' + LF + 'Echo fox ';
		const messyBytes = bytesOf(canonicalizePhrase(messy));
		const plainBytes = bytesOf(canonicalizePhrase(PLAIN));
		expect(textOf(messyBytes)).toBe(PLAIN);
		expect(Array.from(messyBytes)).toEqual(Array.from(plainBytes));
	});

	it('5 and 7 tokens are WORD_COUNT', () => {
		expect(canonicalizePhrase('apple harbor cable dog echo')).toEqual({
			ok: false,
			code: 'E_WORD_COUNT',
			numbers: false
		});
		expect(canonicalizePhrase(PLAIN + ' golf')).toEqual({
			ok: false,
			code: 'E_WORD_COUNT',
			numbers: false
		});
	});

	it('empty and whitespace-only are WORD_COUNT', () => {
		const blank = ' ' + TAB + LF + NBSP;
		for (const input of ['', blank]) {
			expect(canonicalizePhrase(input)).toEqual({
				ok: false,
				code: 'E_WORD_COUNT',
				numbers: false
			});
		}
	});

	it('toLowerCase, not toLocaleLowerCase', () => {
		const spy = vi.spyOn(String.prototype, 'toLocaleLowerCase');
		const upper = bytesOf(canonicalizePhrase('Ice harbor cable dog echo fox'));
		const lower = bytesOf(canonicalizePhrase('ice harbor cable dog echo fox'));
		expect(spy).not.toHaveBeenCalled();
		expect(Array.from(upper)).toEqual(Array.from(lower));
		const capitalI = bytesOf(canonicalizePhrase('I harbor cable dog echo fox'));
		const smallI = bytesOf(canonicalizePhrase('i harbor cable dog echo fox'));
		expect(Array.from(capitalI)).toEqual(Array.from(smallI));
	});

	it('pins the Kelvin sign to ASCII k with the same bytes', () => {
		const withKelvin = bytesOf(canonicalizePhrase('pea' + KELVIN + ' harbor cable dog echo fox'));
		const withK = bytesOf(canonicalizePhrase('peak harbor cable dog echo fox'));
		expect(Array.from(withKelvin)).toEqual(Array.from(withK));
	});

	it.each([
		{
			name: 'numbered paste',
			input: '1. apple 2. harbor 3. cable 4. dog 5. echo 6. fox',
			want: { ok: false, code: 'E_WORD_COUNT', numbers: true }
		},
		{
			name: 'digits with the wrong count',
			input: 'apple harbor cable 4 dog echo fox',
			want: { ok: false, code: 'E_WORD_COUNT', numbers: true }
		},
		{
			name: 'commas between six tokens',
			input: 'apple, harbor, cable, dog, echo, fox',
			want: { ok: false, code: 'E_NOT_LETTERS', position: 1 }
		},
		{
			name: 'a trailing period on word 6',
			input: 'apple harbor cable dog echo fox.',
			want: { ok: false, code: 'E_NOT_LETTERS', position: 6 }
		},
		{
			name: 'a full-width word',
			input: 'harbor ' + FULL_WIDTH_APPLE + ' cable dog echo fox',
			want: { ok: false, code: 'E_NOT_LETTERS', position: 2 }
		},
		{
			name: 'a zero-width space inside word 3',
			input: 'apple harbor ca' + ZWSP + 'ble dog echo fox',
			want: { ok: false, code: 'E_NOT_LETTERS', position: 3 }
		},
		{
			name: 'a digit inside a word of a six-token phrase',
			input: 'apple harbor cable dog echo f0x',
			want: { ok: false, code: 'E_NOT_LETTERS', position: 6 }
		}
	])('$name', ({ input, want }) => {
		expect(canonicalizePhrase(input)).toEqual(want);
	});

	it('reports only the first bad position', () => {
		expect(canonicalizePhrase('apple harbor ca-ble dog e.cho fox')).toEqual({
			ok: false,
			code: 'E_NOT_LETTERS',
			position: 3
		});
	});
});

describe('parseCanonicalBytes', () => {
	it('returns the six tokens of the plain phrase', () => {
		expect(parseCanonicalBytes(encode(PLAIN))).toEqual([...SHOWN]);
	});

	it.each([
		{ name: 'a double space', bytes: encode('apple  harbor cable dog echo fox') },
		{ name: 'a leading space', bytes: encode(' ' + PLAIN) },
		{ name: 'a trailing space', bytes: encode(PLAIN + ' ') },
		{ name: 'a tab between words', bytes: encode('apple' + TAB + 'harbor cable dog echo fox') },
		{ name: 'an upper-case byte', bytes: encode('Apple harbor cable dog echo fox') },
		{ name: 'a seventh word', bytes: encode(PLAIN + ' golf') },
		{ name: 'five words', bytes: encode('apple harbor cable dog echo') },
		{ name: 'a digit', bytes: encode('apple harbor cable dog echo f0x') },
		{ name: 'a non-ASCII letter', bytes: encode('apple harbor cable dog echo f' + KELVIN + 'x') },
		{ name: 'no bytes', bytes: new Uint8Array(0) },
		{
			name: 'a leading byte-order mark',
			bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...encode(PLAIN)])
		},
		{
			name: 'a non-UTF-8 byte',
			bytes: new Uint8Array([...encode(PLAIN), 0xff])
		}
	])('returns null for $name', ({ bytes }) => {
		expect(parseCanonicalBytes(bytes)).toBeNull();
	});
});

describe('compareTypedBack', () => {
	it('accepts the same words in another case and spacing, with the typed bytes', () => {
		const typed = '  APPLE' + TAB + 'Harbor  cable' + LF + 'dog' + NBSP + 'echo FOX  ';
		const result = compareTypedBack(typed, SHOWN);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('typed text did not match');
		expect(textOf(result.bytes)).toBe(PLAIN);
		expect(Array.from(result.bytes)).toEqual(Array.from(bytesOf(canonicalizePhrase(typed))));
	});

	it('names the first word that differs', () => {
		expect(compareTypedBack('apple harbor cabin dog ember fox', SHOWN)).toEqual({
			ok: false,
			code: 'E_TYPE_BACK_MISMATCH',
			position: 3
		});
	});

	it('names the last position when only word 6 differs', () => {
		expect(compareTypedBack('apple harbor cable dog echo fix', SHOWN)).toEqual({
			ok: false,
			code: 'E_TYPE_BACK_MISMATCH',
			position: 6
		});
	});

	it('passes a count failure on unchanged', () => {
		expect(compareTypedBack('apple harbor cable dog echo', SHOWN)).toEqual({
			ok: false,
			code: 'E_WORD_COUNT',
			numbers: false
		});
	});

	it('passes a letters failure on unchanged', () => {
		expect(compareTypedBack('apple harbor cable dog echo fox.', SHOWN)).toEqual({
			ok: false,
			code: 'E_NOT_LETTERS',
			position: 6
		});
	});

	it.each([
		{ name: 'five words', words: ['apple', 'harbor', 'cable', 'dog', 'echo'] },
		{ name: 'seven words', words: [...SHOWN, 'golf'] },
		{ name: 'an upper-case word', words: ['apple', 'harbor', 'Cable', 'dog', 'echo', 'fox'] },
		{ name: 'a word with a digit', words: ['apple', 'harbor', 'cable', 'dog', 'echo', 'f0x'] },
		{ name: 'an empty word', words: ['apple', 'harbor', 'cable', 'dog', 'echo', ''] }
	])('throws E_INTERNAL for $name', ({ words }) => {
		expect(() => compareTypedBack(PLAIN, words)).toThrow('E_INTERNAL');
	});
});
