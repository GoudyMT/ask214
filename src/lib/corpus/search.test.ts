import { describe, it, expect } from 'vitest';
import { normalize, cosineSimilarity } from './search';
import { CorpusFormatError } from './errors';

describe('normalize', () => {
	it('scales a vector to unit length', () => {
		const u = normalize(new Float32Array([3, 4])); // magnitude 5
		expect(u[0]).toBeCloseTo(0.6, 6);
		expect(u[1]).toBeCloseTo(0.8, 6);
		const mag = Math.sqrt(u[0]! * u[0]! + u[1]! * u[1]!);
		expect(mag).toBeCloseTo(1, 6);
	});

	it('throws on a zero-magnitude vector (cannot normalize)', () => {
		expect(() => normalize(new Float32Array([0, 0, 0]))).toThrow(CorpusFormatError);
	});
});

describe('cosineSimilarity', () => {
	it('is 1 for identical directions', () => {
		expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
	});

	it('is 0 for orthogonal vectors', () => {
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
	});

	it('is -1 for opposite directions', () => {
		expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 6);
	});
});
