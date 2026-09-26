import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { documentLibrary, localDocumentInfo } from './document-library';
import { LOCAL_DOCUMENT_BYTES, LOCAL_DOCUMENTS } from './local-documents.data';
import { WEB_SOURCE_COUNT } from './local-document-info.data';
import { SOURCES_INDEX } from './sources-index.data';

// The Settings row and the Documents page both read the library through this one function, so they can
// never disagree about what is saved.
describe('documentLibrary', () => {
	it('lists every served document, in the map order, with its path, size, title, pages and state', () => {
		const vet = LOCAL_DOCUMENTS['tap_vet_centers'] ?? '';
		const library = documentLibrary([vet]);
		expect(library.map((d) => d.sourceId)).toEqual(Object.keys(LOCAL_DOCUMENTS));
		expect(library.find((d) => d.sourceId === 'tap_vet_centers')).toEqual({
			sourceId: 'tap_vet_centers',
			path: vet,
			bytes: LOCAL_DOCUMENT_BYTES['tap_vet_centers'],
			title: 'TAP - Vet Centers (Resource Guide)',
			publisher: 'VA',
			pages: 2,
			state: 'saved',
			stale: []
		});
		expect(library.filter((d) => d.state === 'saved').map((d) => d.sourceId)).toEqual([
			'tap_vet_centers'
		]);
	});

	it('carries the older copies to clear with the document they belong to', () => {
		const old = '/docs/tap_va101.0badc0de.pdf';
		const va101 = documentLibrary([old]).find((d) => d.sourceId === 'tap_va101');
		expect(va101?.state).toBe('updated');
		expect(va101?.stale).toEqual([old]);
	});
});

describe('localDocumentInfo', () => {
	// The Documents area states a document's page count before it is opened, so the number must be the served
	// file's own. It is read here with the library directly, not through the generator's helper, so the check
	// cannot agree with the generator merely by sharing its code.
	// Two small documents with DIFFERENT counts, so a generator that wrote one constant cannot pass.
	it("reports a served document's page count as the file's own", async () => {
		const counts: number[] = [];
		for (const sourceId of ['tap_vet_centers', 'tap_va101']) {
			const path = LOCAL_DOCUMENTS[sourceId] ?? '';
			const task = getDocument({
				data: new Uint8Array(readFileSync(`static${path}`)),
				useSystemFonts: false,
				verbosity: 0
			});
			const pages = (await task.promise).numPages;
			await task.destroy();
			counts.push(pages);
			expect(localDocumentInfo(sourceId)?.pages).toBe(pages);
		}
		expect(new Set(counts).size).toBe(2);
	});

	// The registry writes this one title in double quotes because it carries an apostrophe. A line-by-line
	// reader of the YAML dropped it once; the title must arrive whole, as the About page shows it.
	it('carries a title with an apostrophe whole, with its publisher', () => {
		expect(localDocumentInfo('tap_va_womens_health')).toMatchObject({
			title: "TAP - VA Women's Health Transition Training Participant Handbook",
			publisher: 'VA'
		});
	});

	// The Documents page names how many sources are web pages. It reads this one generated number rather than
	// importing the About page's whole index to count it.
	it('counts the web-page sources the same way the About index lists them', () => {
		expect(WEB_SOURCE_COUNT).toBeGreaterThan(0);
		expect(WEB_SOURCE_COUNT).toBe(SOURCES_INDEX.agency.length);
	});

	it('describes every served document', () => {
		for (const sourceId of Object.keys(LOCAL_DOCUMENTS)) {
			expect(localDocumentInfo(sourceId)?.pages).toBeGreaterThan(0);
		}
	});

	it('returns undefined for an html source, a prototype key or an unknown id', () => {
		expect(localDocumentInfo('va_intent_to_file')).toBeUndefined();
		expect(localDocumentInfo('constructor')).toBeUndefined();
		expect(localDocumentInfo('toString')).toBeUndefined();
		expect(localDocumentInfo('__proto__')).toBeUndefined();
		expect(localDocumentInfo('not_a_source')).toBeUndefined();
	});
});
