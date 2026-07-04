import { describe, it, expect } from 'vitest';
import { tokenize, buildBm25Index, bm25Scores } from './bm25';

describe('tokenize', () => {
	it('lowercases + splits on non-alphanumerics, keeping acronyms + form numbers', () => {
		expect(tokenize('File VA Form 21-526EZ (BDD)?')).toEqual([
			'file',
			'va',
			'form',
			'21',
			'526ez',
			'bdd'
		]);
	});
});

describe('bm25Scores', () => {
	const docs = [
		'file a VA disability claim and gather your evidence',
		'apply for VA health care and check eligibility',
		'transfer your GI Bill to your dependents'
	];
	const index = buildBm25Index(docs);

	it('ranks the keyword-matching doc highest (aligned to doc order)', () => {
		const s = bm25Scores('disability claim evidence', index);
		expect(s.indexOf(Math.max(...s))).toBe(0);
	});

	it('scores 0 for a query with no term overlap - the correct-empty signal', () => {
		expect(Math.max(...bm25Scores('quantum astrophysics lecture', index))).toBe(0);
	});

	it('is driven by rare terms via IDF (a term unique to one doc wins)', () => {
		// 'eligibility' appears only in doc 1, so doc 1 must rank top.
		const s = bm25Scores('eligibility', index);
		expect(s.indexOf(Math.max(...s))).toBe(1);
	});

	it('returns one score per document', () => {
		expect(bm25Scores('va', index)).toHaveLength(docs.length);
	});
});
