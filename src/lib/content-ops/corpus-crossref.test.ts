import { describe, it, expect } from 'vitest';
import { validateCorpusAgainstRegistry } from './corpus-crossref';

const registry = [
	{ source_id: 'va_x', legal_tier: 'confident_pd' },
	{ source_id: 'old_y', legal_tier: 'excluded' }
];
// captured-original extracted text per sourceId (already plain text; the validator normalizes it)
const extractions = { va_x: 'Before. A verbatim span here. After.' };

const baseChunk = {
	id: 'va_x:abc123abc123',
	text: 'A verbatim span here.',
	sourceId: 'va_x',
	sourceTitle: 'X',
	tags: [] as string[],
	url: 'https://www.va.gov/x'
};

describe('validateCorpusAgainstRegistry', () => {
	it('accepts a clean corpus with a resolving anchor', () => {
		const chunk = {
			...baseChunk,
			anchor: { exact: 'A verbatim span here.', prefix: 'Before. ', suffix: ' After.' }
		};
		expect(validateCorpusAgainstRegistry([chunk], registry, extractions)).toEqual({
			valid: true,
			errors: []
		});
	});

	it('flags a chunk pointing at an unknown source', () => {
		const chunk = { ...baseChunk, sourceId: 'nope' };
		const r = validateCorpusAgainstRegistry([chunk], registry, extractions);
		expect(r.errors).toContainEqual({ code: 'E_XREF_UNKNOWN_SOURCE', sourceId: 'nope' });
	});

	it('flags a chunk pointing at an excluded source', () => {
		const chunk = { ...baseChunk, sourceId: 'old_y' };
		const r = validateCorpusAgainstRegistry([chunk], registry, extractions);
		expect(r.errors).toContainEqual({ code: 'E_XREF_EXCLUDED_SOURCE', sourceId: 'old_y' });
	});

	it('flags duplicate chunk ids', () => {
		const r = validateCorpusAgainstRegistry([baseChunk, { ...baseChunk }], registry, extractions);
		expect(r.errors).toContainEqual({ code: 'E_XREF_DUP_ID', sourceId: 'va_x' });
	});

	it('flags a malformed chunk id', () => {
		const r = validateCorpusAgainstRegistry(
			[{ ...baseChunk, id: 'not-an-id' }],
			registry,
			extractions
		);
		expect(r.errors).toContainEqual({ code: 'E_XREF_BAD_ID', sourceId: 'va_x' });
	});

	it('fails to resolve an anchor whose exact text is absent from the source', () => {
		const chunk = { ...baseChunk, anchor: { exact: 'text that is not present' } };
		const r = validateCorpusAgainstRegistry([chunk], registry, extractions);
		expect(r.errors).toContainEqual({ code: 'E_XREF_ANCHOR_UNRESOLVED', sourceId: 'va_x' });
	});

	it('flags an anchor whose window appears more than once as ambiguous', () => {
		const chunk = { ...baseChunk, anchor: { exact: 'echo' } };
		const r = validateCorpusAgainstRegistry([chunk], registry, { va_x: 'echo ... echo' });
		expect(r.errors).toContainEqual({ code: 'E_XREF_ANCHOR_AMBIGUOUS', sourceId: 'va_x' });
	});
});
