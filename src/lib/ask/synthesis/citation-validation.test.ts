import { describe, it, expect } from 'vitest';
import { validateCitations } from './citation-validation';

describe('validateCitations', () => {
	it('accepts citations that all resolve to retrieved chunks', () => {
		const r = validateCitations(['c1', 'c2'], new Set(['c1', 'c2', 'c3']));
		expect(r.ok).toBe(true);
		expect(r.invalidIds).toEqual([]);
	});
	it('flags a citation to a non-retrieved id (query-forged chunk)', () => {
		const r = validateCitations(['c1', 'forged'], new Set(['c1', 'c2']));
		expect(r.ok).toBe(false);
		expect(r.invalidIds).toEqual(['forged']);
	});
});
