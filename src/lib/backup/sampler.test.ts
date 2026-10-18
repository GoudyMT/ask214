import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSampler } from './sampler';
import { WORDS_V1 } from './words-v1';

const RANGE = 65536;
const sampler = createSampler(WORDS_V1);
const N = WORDS_V1.length;

// Feeds the next scripted value into each 16-bit draw and refuses anything that is not one 16-bit draw.
function scriptDraws(values: readonly number[]) {
	const queue = [...values];
	return vi
		.spyOn(crypto, 'getRandomValues')
		.mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
			const next = queue.shift();
			if (next === undefined) throw new Error('script ran out');
			if (!(array instanceof Uint16Array)) throw new Error('not a Uint16Array');
			array[0] = next;
			return array;
		});
}

function wordAt(index: number): string {
	const word = WORDS_V1[index];
	if (word === undefined) throw new Error('index outside the list');
	return word;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('createSampler', () => {
	it('exhaustive mapping: every index is hit equally often and the leftover samples are rejected', () => {
		const hits = new Array<number>(N).fill(0);
		let rejected = 0;
		for (let x = 0; x < RANGE; x++) {
			const index = sampler.indexFromSample(x);
			if (index === null) {
				rejected++;
			} else {
				hits[index] = (hits[index] ?? 0) + 1;
			}
		}
		expect(rejected).toBe(RANGE % N);
		const each = Math.floor(RANGE / N);
		expect(hits.every((count) => count === each)).toBe(true);
	});

	it('generatePhrase skips rejected samples', () => {
		const accepted = [0, 1, N - 1, N + 3, 500, 7];
		const spy = scriptDraws([sampler.SAMPLE_LIMIT, 65535, ...accepted]);
		expect(sampler.generatePhrase()).toEqual([
			wordAt(0),
			wordAt(1),
			wordAt(N - 1),
			wordAt(3),
			wordAt(500),
			wordAt(7)
		]);
		expect(spy).toHaveBeenCalledTimes(8);
	});

	it('generatePhrase keeps repeated words', () => {
		// The spare values after the six repeats let a sampler that dropped repeats finish, and so fail on its words.
		scriptDraws([42, 42, 42, 42, 42, 42, 43, 44, 45, 46, 47, 48]);
		const phrase = sampler.generatePhrase();
		expect(phrase).toHaveLength(6);
		expect(phrase).toEqual(new Array<string>(6).fill(wordAt(42)));
	});

	it('createSampler refuses lists of 0, 1 and 65,537 words', () => {
		for (const size of [0, 1, RANGE + 1]) {
			const list = new Array<string>(size).fill('word');
			expect(() => createSampler(list), String(size)).toThrow('E_INTERNAL');
		}
	});

	it('createSampler accepts the smallest and the largest list', () => {
		expect(createSampler(['a', 'b']).SAMPLE_LIMIT).toBe(RANGE);
		const largest = createSampler(new Array<string>(RANGE).fill('word'));
		expect(largest.N).toBe(RANGE);
		expect(largest.SAMPLE_LIMIT).toBe(RANGE);
	});
});
