import { describe, test, expect } from 'vitest';
import { checkExtractionSanity } from './fidelity';

const FFFD = String.fromCharCode(0xfffd); // U+FFFD replacement char, built ASCII-safely

describe('checkExtractionSanity', () => {
	test('clean text passes with no issues', () => {
		const r = checkExtractionSanity(
			'A clear paragraph of extracted government text about how to file a claim.'
		);
		expect(r).toEqual({ ok: true, issues: [] });
	});

	test('empty / whitespace-only text is flagged empty', () => {
		expect(checkExtractionSanity('   \n  ').issues).toContain('E_FIDELITY_EMPTY');
	});

	test('too few chars per page is flagged low-coverage', () => {
		const r = checkExtractionSanity('tiny', { pages: 20 });
		expect(r.issues).toContain('E_FIDELITY_LOW_COVERAGE');
	});

	test('replacement / control chars above the ratio are flagged garbled', () => {
		const r = checkExtractionSanity('abc' + FFFD.repeat(5) + 'def');
		expect(r.issues).toContain('E_FIDELITY_GARBLED');
	});
});
