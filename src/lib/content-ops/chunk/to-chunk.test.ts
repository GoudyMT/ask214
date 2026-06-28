import { describe, it, expect } from 'vitest';
import { toChunk } from './to-chunk';
import type { ChunkSpan } from './split';

const entry = {
	source_id: 'va_intent_to_file',
	title: 'Your intent to file',
	url: 'https://www.va.gov/x',
	origin: 'VA'
};

function span(text: string, extra: Partial<ChunkSpan> = {}): ChunkSpan {
	return { text, startOffset: 0, endOffset: text.length, brokeAtTokenLevel: false, ...extra };
}

describe('toChunk', () => {
	it('assembles the full CorpusChunk: id, verbatim text, source metadata, tags=[origin lowercased], url', async () => {
		const seen = new Map<string, number>();
		const c = await toChunk(
			span('Submit your intent to file.', { section: 'How to file' }),
			{ exact: 'Submit your intent to file.' },
			entry,
			seen
		);
		expect(c.text).toBe('Submit your intent to file.');
		expect(c.sourceId).toBe('va_intent_to_file');
		expect(c.sourceTitle).toBe('Your intent to file');
		expect(c.url).toBe('https://www.va.gov/x');
		expect(c.tags).toEqual(['va']);
		expect(c.section).toBe('How to file');
		expect(c.anchor).toEqual({ exact: 'Submit your intent to file.' });
		expect(c.id).toMatch(/^va_intent_to_file:[0-9a-f]{12}$/);
	});

	it('appends -n to disambiguate an intra-source exact-duplicate chunk text', async () => {
		const seen = new Map<string, number>();
		const a = await toChunk(span('Overview'), null, entry, seen);
		const b = await toChunk(span('Overview'), null, entry, seen);
		expect(a.id).toMatch(/^va_intent_to_file:[0-9a-f]{12}$/);
		expect(b.id).toBe(`${a.id}-1`);
	});

	it('omits anchor/page/section when absent (not set to undefined)', async () => {
		const seen = new Map<string, number>();
		const c = await toChunk(span('plain text'), null, entry, seen);
		expect(Object.prototype.hasOwnProperty.call(c, 'anchor')).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(c, 'page')).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(c, 'section')).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(c, 'excerpt')).toBe(false);
	});

	it('carries page through for the scanned-pdf path', async () => {
		const seen = new Map<string, number>();
		const c = await toChunk(span('page body', { page: 7 }), null, entry, seen);
		expect(c.page).toBe(7);
	});
});
