/**
 * Picks the six words of a backup passphrase.
 *
 * Each word is an independent draw, so every word of the list is equally likely and the same word may come up more
 * than once. Repeats must stay allowed: the 77-bit bar holds by only 0.0009 bits at 7,299 words, and any filter on
 * the draws (no repeats, no neighbours) would take the passphrase below it.
 *
 * Rejection sampling, because `x % N` on the whole 16-bit range would favour the low indexes: the samples at or
 * above SAMPLE_LIMIT are thrown away and redrawn, so every index is hit by exactly the same number of samples.
 *
 * This module holds no word list; the one caller hands the list in, so the list is imported in one place only.
 */

const WORD_COUNT = 6;
const SAMPLE_RANGE = 65536;

export type Sampler = Readonly<{
	N: number;
	SAMPLE_LIMIT: number;
	indexFromSample: (x: number) => number | null;
	generatePhrase: () => string[];
}>;

export function createSampler(words: readonly string[]): Sampler {
	const N = words.length;
	if (N < 2 || N > SAMPLE_RANGE) throw new Error('E_INTERNAL');
	const SAMPLE_LIMIT = SAMPLE_RANGE - (SAMPLE_RANGE % N);

	function indexFromSample(x: number): number | null {
		return x < SAMPLE_LIMIT ? x % N : null;
	}

	function generatePhrase(): string[] {
		const phrase: string[] = [];
		while (phrase.length < WORD_COUNT) {
			const draw = new Uint16Array(1);
			crypto.getRandomValues(draw);
			const index = indexFromSample(draw[0] ?? SAMPLE_RANGE);
			const word = index === null ? undefined : words[index];
			if (word !== undefined) phrase.push(word);
		}
		return phrase;
	}

	return Object.freeze({ N, SAMPLE_LIMIT, indexFromSample, generatePhrase });
}
