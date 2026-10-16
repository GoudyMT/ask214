/**
 * The one exact byte string a backup passphrase turns into.
 *
 * A backup is locked with six words the app shows. People type them back with capitals, stray spaces, a tab, a
 * line break or a non-breaking space from a paste, and the same six words must always open the same backup. So
 * every typed form is folded to one canonical text (six lower-case words joined by single spaces) and its UTF-8
 * bytes are the only form that leaves the main thread.
 *
 * - Lower-casing uses `toLowerCase`, never `toLocaleLowerCase`: in a Turkish locale the locale form maps `I` to a
 *   dotless i, so the same words would give other bytes on that device and lock a person out of their own backup.
 * - Nothing is stripped or mapped beyond whitespace. Every accepted word is plain letters a to z, so any other
 *   character (a comma, a number, a zero-width space, a full-width letter) is a mistake to report, not to repair;
 *   repairing it would let two different texts open the same backup.
 * - Results carry a position (1 to 6) and never the word: the person's words are a secret, and an error that
 *   echoed one would put it in a log or on screen.
 *
 * This module holds no word list. Whether a word belongs to the list is checked later, where the list lives.
 */

export type PhrasePosition = 1 | 2 | 3 | 4 | 5 | 6;

export type CanonicalFailure =
	| { ok: false; code: 'E_WORD_COUNT'; numbers: boolean }
	| { ok: false; code: 'E_NOT_LETTERS'; position: PhrasePosition };

export type CanonicalResult = { ok: true; bytes: Uint8Array<ArrayBuffer> } | CanonicalFailure;

export type TypedBackResult =
	| { ok: true; bytes: Uint8Array<ArrayBuffer> }
	| CanonicalFailure
	| { ok: false; code: 'E_TYPE_BACK_MISMATCH'; position: PhrasePosition };

const WORD_COUNT = 6;
const POSITIONS: readonly PhrasePosition[] = [1, 2, 3, 4, 5, 6];
// The JS whitespace class: space, tab, LF, CR, VT, FF, NBSP, every Zs space, U+2028, U+2029 and U+FEFF.
const WHITESPACE_RUN = /\s+/u;
const PLAIN_WORD = /^[a-z]+$/;
const ASCII_DIGIT = /[0-9]/;

function positionOf(index: number): PhrasePosition {
	const position = POSITIONS[index];
	if (position === undefined) throw new Error('E_INTERNAL');
	return position;
}

function isSixPlainWords(tokens: readonly string[]): boolean {
	return tokens.length === WORD_COUNT && tokens.every((token) => PLAIN_WORD.test(token));
}

type Folded =
	{ ok: true; tokens: readonly string[]; bytes: Uint8Array<ArrayBuffer> } | CanonicalFailure;

function fold(input: string): Folded {
	const tokens = input
		.toLowerCase()
		.split(WHITESPACE_RUN)
		.filter((token) => token !== '');
	if (tokens.length !== WORD_COUNT) {
		return { ok: false, code: 'E_WORD_COUNT', numbers: tokens.some((t) => ASCII_DIGIT.test(t)) };
	}
	const bad = tokens.findIndex((token) => !PLAIN_WORD.test(token));
	if (bad !== -1) return { ok: false, code: 'E_NOT_LETTERS', position: positionOf(bad) };
	return { ok: true, tokens, bytes: new TextEncoder().encode(tokens.join(' ')) };
}

export function canonicalizePhrase(input: string): CanonicalResult {
	const folded = fold(input);
	return folded.ok ? { ok: true, bytes: folded.bytes } : folded;
}

/**
 * The worker's side: reads the canonical bytes back into six words before any key work. Only the exact canonical
 * shape passes (single spaces, lower-case letters, valid UTF-8), so a bug upstream shows up as null, never as a
 * different key.
 */
export function parseCanonicalBytes(bytes: Uint8Array): readonly string[] | null {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
	const tokens = text.split(' ');
	return isSixPlainWords(tokens) ? tokens : null;
}

/**
 * The export type-back: the shown words are the reference, so no list is needed. On a match the bytes are those of
 * the typed text, the form the export key derives from.
 */
export function compareTypedBack(typed: string, words: readonly string[]): TypedBackResult {
	if (!isSixPlainWords(words)) throw new Error('E_INTERNAL');
	const folded = fold(typed);
	if (!folded.ok) return folded;
	const differs = folded.tokens.findIndex((token, i) => token !== words[i]);
	if (differs !== -1) {
		return { ok: false, code: 'E_TYPE_BACK_MISMATCH', position: positionOf(differs) };
	}
	return { ok: true, bytes: folded.bytes };
}
