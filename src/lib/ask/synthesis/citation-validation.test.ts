import { describe, it, expect } from 'vitest';
import { parseCitedIds, stripCitations, validateCitations } from './citation-validation';

// The corpus itself prints bracketed acronyms ("Transfer of Entitlement [TOE]", "[DOS]"). A chunk id is all
// lowercase, so an uppercase bracket is the source's own words: read as a citation it names no retrieved id and
// the whole answer was refused for quoting its source.
describe('the citation marker', () => {
	const ID = 'dod_skillbridge:89e8cdda8199';

	it('reads a bracketed acronym as prose, not as a cited id', () => {
		const text = `Also known as Transfer of Entitlement [TOE] and [DOS] [${ID}].`;
		expect(parseCitedIds(text)).toEqual([ID]);
	});

	it('leaves a bracketed acronym in the prose the reader sees and removes only the real marker', () => {
		const text = `Also known as Transfer of Entitlement [TOE] [${ID}].`;
		expect(stripCitations(text)).toBe('Also known as Transfer of Entitlement [TOE].');
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
