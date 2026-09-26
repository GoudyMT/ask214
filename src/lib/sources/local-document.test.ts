import { statSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { localDocumentPath, localDocumentSize } from './local-document';
import { LOCAL_DOCUMENTS } from './local-documents.data';

describe('localDocumentPath', () => {
	it('resolves a served pdf source to its content-addressed path', () => {
		const [sourceId] = Object.keys(LOCAL_DOCUMENTS);
		expect(localDocumentPath(sourceId as string)).toMatch(/^\/docs\/[a-z0-9_]+\.[0-9a-f]{8}\.pdf$/);
	});

	it('returns undefined for an html source, which is never re-hosted', () => {
		expect(localDocumentPath('va_intent_to_file')).toBeUndefined();
	});

	// Not hypothetical: documentUrl shipped this exact bug. A bare index reaches Object.prototype, so a
	// sourceId of "constructor" returned a stringified function - a non-empty string, which defeated every
	// caller's fallback and put that value into a citation href.
	it('returns undefined for a prototype key rather than reaching Object.prototype', () => {
		expect(localDocumentPath('constructor')).toBeUndefined();
		expect(localDocumentPath('toString')).toBeUndefined();
		expect(localDocumentPath('__proto__')).toBeUndefined();
	});

	it('returns undefined for an unknown id', () => {
		expect(localDocumentPath('not_a_source')).toBeUndefined();
	});

	// The generated map is the app's only route to a served document, so an empty one means tier 3 is
	// silently dead for every source.
	it('the generated map covers every served document', () => {
		expect(Object.keys(LOCAL_DOCUMENTS).length).toBeGreaterThan(0);
	});
});

// The reader states a document's size before its first download, so the number must be the real file's.
describe('localDocumentSize', () => {
	it("reports every served document's size as its file's size on disk", () => {
		for (const [sourceId, path] of Object.entries(LOCAL_DOCUMENTS)) {
			expect(localDocumentSize(sourceId)).toBe(statSync(`static${path}`).size);
		}
	});

	it('returns undefined for an html source, a prototype key or an unknown id', () => {
		expect(localDocumentSize('va_intent_to_file')).toBeUndefined();
		expect(localDocumentSize('constructor')).toBeUndefined();
		expect(localDocumentSize('toString')).toBeUndefined();
		expect(localDocumentSize('__proto__')).toBeUndefined();
		expect(localDocumentSize('not_a_source')).toBeUndefined();
	});
});
