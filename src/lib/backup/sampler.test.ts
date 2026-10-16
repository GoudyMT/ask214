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
	it('derives N and SAMPLE_LIMIT from the list and freezes the result', () => {
		expect(sampler.N).toBe(N);
		expect(sampler.SAMPLE_LIMIT).toBe(RANGE - (RANGE % N));
		expect(Object.isFrozen(sampler)).toBe(true);
	});

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

	it('6*log2(distinct indexes indexFromSample can return) >= 77', () => {
		const seen = new Set<number>();
		for (let x = 0; x < RANGE; x++) {
			const index = sampler.indexFromSample(x);
			if (index !== null) seen.add(index);
		}
		expect(6 * Math.log2(seen.size)).toBeGreaterThanOrEqual(77);
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

	it('generatePhrase takes no parameters', () => {
		expect(sampler.generatePhrase.length).toBe(0);
	});

	it('each draw is one 16-bit value', () => {
		const spy = scriptDraws([1, 2, 3, 4, 5, 6]);
		sampler.generatePhrase();
		expect(spy).toHaveBeenCalledTimes(6);
		for (const [array] of spy.mock.calls) {
			expect(array).toBeInstanceOf(Uint16Array);
			expect((array as Uint16Array).length).toBe(1);
		}
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
