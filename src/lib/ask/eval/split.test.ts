import { describe, it, expect } from 'vitest';
import { evalBucket, partitionEvalSet } from './split';
import type { EvalQuery } from './resolve-ground-truth';

const pos = (query: string): EvalQuery => ({ query, sourceId: 's', answerSnippet: 'x' });
const neg = (query: string): EvalQuery => ({ query, expectEmpty: true });

describe('evalBucket', () => {
	it('is a deterministic djb2 bucket in [0, 100)', () => {
		// Pinned by hand: djb2('a') = 5381*33 + 97 = 177670 -> % 100 = 70.
		expect(evalBucket('a')).toBe(70);
		// djb2('ab') = 177670*33 + 98 = 5863208 -> % 100 = 8.
		expect(evalBucket('ab')).toBe(8);
		expect(evalBucket('a')).toBe(evalBucket('a')); // stable across calls
	});
});

describe('partitionEvalSet', () => {
	it('sends bucket < heldOutPct to heldOut and the rest to tune', () => {
		const { tune, heldOut } = partitionEvalSet([pos('a'), neg('ab')], 30);
		expect(heldOut.map((q) => q.query)).toEqual(['ab']); // bucket 8 < 30
		expect(tune.map((q) => q.query)).toEqual(['a']); // bucket 70 >= 30
	});

	it('partitions completely and disjointly (tune + heldOut = input)', () => {
		const set = [pos('a'), neg('ab'), pos('hello'), neg('world')];
		const { tune, heldOut } = partitionEvalSet(set, 30);
		expect(tune.length + heldOut.length).toBe(set.length);
		const all = [...tune, ...heldOut].map((q) => q.query).sort();
		expect(all).toEqual(set.map((q) => q.query).sort());
	});

	it('is FROZEN: a query stays on the same side regardless of the rest of the set (no leakage)', () => {
		const small = partitionEvalSet([pos('a'), neg('ab')], 30);
		const large = partitionEvalSet([pos('a'), pos('hello'), neg('world'), neg('ab')], 30);
		const sideIn = (part: { heldOut: EvalQuery[] }) =>
			part.heldOut.some((q) => q.query === 'ab') ? 'heldOut' : 'tune';
		expect(sideIn(small)).toBe(sideIn(large)); // 'ab' lands the same side in both sets
	});

	it('respects the heldOutPct bound at the extremes', () => {
		const set = [pos('a'), neg('ab'), pos('hello')];
		expect(partitionEvalSet(set, 0).heldOut).toEqual([]); // nothing is < 0
		expect(partitionEvalSet(set, 100).tune).toEqual([]); // every bucket 0..99 is < 100
	});
});
