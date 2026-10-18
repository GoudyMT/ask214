import { describe, it, expect } from 'vitest';
import {
	validateCitations,
	parseCitedIds,
	stripCitations,
	printedAcronyms
} from './citation-validation';

describe('printedAcronyms', () => {
	// The one input the exemption trusts is the sources' own text, so only an exact bracket of capital letters
	// printed there counts: not another case, not an id, not digits.
	it('collects only the capital-letter brackets the texts print', () => {
		const printed = printedAcronyms([
			'Transfer of Entitlement [TOE] and [DOS].',
			'See [Toe], [toe], [DOD_GUIDE], [988] and [dod_skillbridge:89e8cdda8199].'
		]);
		expect([...printed].sort()).toEqual(['DOS', 'TOE']);
	});
});

describe('parseCitedIds and stripCitations with the printed acronyms', () => {
	const text = 'Entitlement [TOE] is on file [a], per [DOD] and [toe].';
	it('reads a bracket as an acronym only when it is in the printed set', () => {
		expect(parseCitedIds(text, new Set(['TOE']))).toEqual(['a', 'DOD', 'toe']);
		expect(stripCitations(text, new Set(['TOE']))).toBe('Entitlement [TOE] is on file, per and.');
	});
	it('reads every bracket as a citation when nothing is printed', () => {
		expect(parseCitedIds(text)).toEqual(['TOE', 'a', 'DOD', 'toe']);
		expect(stripCitations(text)).toBe('Entitlement is on file, per and.');
	});
});

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
