import { describe, test, expect } from 'vitest';
import { trigramSimilarity } from './similarity';

describe('trigramSimilarity', () => {
	test('identical text scores 1', () => {
		const t = 'the quick brown fox jumps over the lazy dog';
		expect(trigramSimilarity(t, t)).toBe(1);
	});

	test('completely different text scores 0', () => {
		expect(trigramSimilarity('alpha beta gamma delta', 'one two three four')).toBe(0);
	});

	test('high overlap scores high but below 1 on partial divergence', () => {
		const a = 'submit your claim online or by mail to the office';
		const b = 'submit your claim online or by fax to the office';
		const s = trigramSimilarity(a, b);
		expect(s).toBeGreaterThan(0.3);
		expect(s).toBeLessThan(1);
	});

	test('two empty texts are trivially equal', () => {
		expect(trigramSimilarity('', '')).toBe(1);
	});
});
