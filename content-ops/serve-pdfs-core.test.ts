import { describe, it, expect } from 'vitest';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
	activeContentIn,
	pdfNamesIn,
	decideServedArtifact,
	checkDerivationRecord,
	countImagePaints,
	keptImageMismatches,
	unlistedServedFiles,
	highlightPopulation,
	documentsWithPictures,
	CAP_BYTES
} from './serve-pdfs-core.mjs';

// The served document is always a DERIVED artifact: the capture carries third-party raster images, so the
// derivation removes them and recompresses what may stay. The text layer is what the runtime highlight
// matcher searches, so a derivation that moves it is rejected - a document that loads but whose citation no
// longer resolves is worse than one that is not served.
describe('decideServedArtifact', () => {
	it('fails closed when no derivation is offered, because the capture is never served', () => {
		expect(() => decideServedArtifact({ derived: null })).toThrow('E_SERVE_NO_DERIVATION');
	});

	it('fails closed when the derivation moved the text layer', () => {
		expect(() => decideServedArtifact({ derived: { bytes: 400, textIdentical: false } })).toThrow(
			'E_SERVE_TEXT_MOVED'
		);
	});

	it('uses the derivation when the text layer is identical', () => {
		expect(decideServedArtifact({ derived: { bytes: 400, textIdentical: true } })).toEqual({
			use: 'derived',
			bytes: 400
		});
	});

	// Measured: 2 of 21 real captures GREW under re-encoding, and the capture used to be kept for them. The
	// capture is no longer an option at any size - it carries the images the derivation removes - so a
	// derivation that grew is still the one served while it fits the cap.
	it('uses the derivation even when it grew under re-encoding', () => {
		expect(decideServedArtifact({ derived: { bytes: 4_500_000, textIdentical: true } })).toEqual({
			use: 'derived',
			bytes: 4_500_000
		});
	});

	it('fails closed when the derivation is still over cap', () => {
		expect(() =>
			decideServedArtifact({ derived: { bytes: CAP_BYTES + 1, textIdentical: true } })
		).toThrow('E_SERVE_PDF_OVER_CAP');
	});

	it('accepts a derivation exactly at the cap', () => {
		const decide = () =>
			decideServedArtifact({ derived: { bytes: CAP_BYTES, textIdentical: true } });
		expect(decide).not.toThrow();
		expect(decide()).toEqual({ use: 'derived', bytes: CAP_BYTES });
	});
});

// The deriving tool writes a record beside each candidate. A candidate is only as trustworthy as the capture
// and the derivation rules it came from, so a record that names another capture or another version of the
// rules rejects the candidate rather than letting it publish under the current name.
describe('checkDerivationRecord', () => {
	const expected = { contentHash: 'abc123', derivationVersion: '2' };
	const record = {
		captureHash: 'abc123',
		darkenedPages: [8, 73],
		derivationVersion: '2',
		jpegQuality: 70,
		keptPerPage: { '1': 5, '32': 1 },
		maxPixels: 1960000,
		removed: 690
	};

	it('returns the kept images, the mid-grey pages, the removed count and the settings of a record that matches', () => {
		expect(checkDerivationRecord(record, expected)).toEqual({
			keptPerPage: { '1': 5, '32': 1 },
			darkenedPages: [8, 73],
			removed: 690,
			derivation: { jpegQuality: 70, maxPixels: 1960000 }
		});
	});

	// The manifest records these pages so a recapture that changes them shows as pages to look at; a record that
	// cannot say which pages they are cannot be reviewed.
	it('fails closed on mid-grey pages that are not increasing page numbers', () => {
		for (const darkenedPages of [undefined, null, {}, [0], [2, 2], [5, 3], [1.5], ['8']]) {
			expect(() => checkDerivationRecord({ ...record, darkenedPages }, expected)).toThrow(
				'E_SERVE_BAD_RECORD'
			);
		}
	});

	// The served manifest records the settings each document was re-encoded with, so a record that does not
	// state them cannot say how the bytes it describes were made.
	it('fails closed on a JPEG quality that is not a whole number on the encoder scale', () => {
		for (const jpegQuality of [undefined, -1, 101, 70.5, '70']) {
			expect(() => checkDerivationRecord({ ...record, jpegQuality }, expected)).toThrow(
				'E_SERVE_BAD_RECORD'
			);
		}
	});

	it('fails closed on a pixel limit that is not a positive whole number', () => {
		for (const maxPixels of [undefined, 0, -1, 1.5, '1960000']) {
			expect(() => checkDerivationRecord({ ...record, maxPixels }, expected)).toThrow(
				'E_SERVE_BAD_RECORD'
			);
		}
	});

	it('fails closed when the candidate has no record', () => {
		expect(() => checkDerivationRecord(null, expected)).toThrow('E_SERVE_NO_RECORD');
	});

	it('fails closed when the record names a different capture', () => {
		expect(() => checkDerivationRecord({ ...record, captureHash: 'fff000' }, expected)).toThrow(
			'E_SERVE_STALE_DERIVATION'
		);
	});

	it('fails closed when the record comes from another derivation version', () => {
		expect(() => checkDerivationRecord({ ...record, derivationVersion: '1' }, expected)).toThrow(
			'E_SERVE_DERIVATION_VERSION'
		);
	});

	// The verifier compares these counts with what each page paints, so a record that cannot say how many
	// images a page keeps cannot be checked at all.
	it('fails closed on a kept count that is not a positive whole number of images', () => {
		for (const keptPerPage of [
			{ '1': 0 },
			{ '1': 1.5 },
			{ '1': '2' },
			{ '0': 1 },
			{ x: 1 },
			null
		]) {
			expect(() => checkDerivationRecord({ ...record, keptPerPage }, expected)).toThrow(
				'E_SERVE_BAD_RECORD'
			);
		}
	});

	it('fails closed on a removed count that is not a whole number', () => {
		for (const removed of [-1, 2.5, '3', undefined]) {
			expect(() => checkDerivationRecord({ ...record, removed }, expected)).toThrow(
				'E_SERVE_BAD_RECORD'
			);
		}
	});
});

// One rule for "an image", shared in meaning with the deriving tool: a paint of raster pixels more than one
// pixel in size. A removed image is replaced by a single pixel, so it drops out of this count, and
// every image left in it must be one the deriving tool kept.
describe('countImagePaints', () => {
	const list = (ops: [number, unknown[]][]) => ({
		fnArray: ops.map(([fn]) => fn),
		argsArray: ops.map(([, args]) => args)
	});

	it('counts each image object painted larger than one pixel', () => {
		const opList = list([
			[OPS.save, []],
			[OPS.paintImageXObject, ['img_p0_1', 640, 480]],
			[OPS.paintImageXObject, ['img_p0_2', 1, 1]],
			[OPS.paintImageXObject, ['img_p0_1', 640, 480]],
			[OPS.restore, []]
		]);
		expect(countImagePaints(opList, OPS)).toBe(2);
	});

	it('counts a strip one pixel tall but wider than one pixel', () => {
		expect(countImagePaints(list([[OPS.paintImageXObject, ['img_p0_1', 300, 1]]]), OPS)).toBe(1);
	});

	// The deriving tool keeps only image objects, so an inline image or a stencil mask that paints real
	// pixels is one it never looked at, and must show up as a mismatch.
	it('counts inline images and stencil masks by the size they carry', () => {
		const opList = list([
			[OPS.paintInlineImageXObject, [{ width: 40, height: 30 }]],
			[OPS.paintInlineImageXObject, [{ width: 1, height: 1 }]],
			[OPS.paintImageMaskXObject, [{ data: 'mask_p0_1', width: 16, height: 16 }]],
			[OPS.paintSolidColorImageMask, []]
		]);
		expect(countImagePaints(opList, OPS)).toBe(2);
	});

	// pdf.js merges runs of images into these only when drawing; the operator list the verifier reads is
	// built without that step. If one ever appears, this rule no longer describes what the page paints.
	it('fails closed on a merged image operation it has no rule for', () => {
		for (const fn of [
			OPS.paintImageXObjectRepeat,
			OPS.paintInlineImageXObjectGroup,
			OPS.paintImageMaskXObjectGroup,
			OPS.paintImageMaskXObjectRepeat
		]) {
			expect(() => countImagePaints(list([[fn, []]]), OPS)).toThrow('E_VERIFY_MERGED_IMAGE_OP');
		}
	});
});

describe('keptImageMismatches', () => {
	it('finds no mismatch when every page paints what the record kept', () => {
		expect(keptImageMismatches({ '1': 2, '3': 1 }, [2, 0, 1])).toEqual([]);
	});

	it('reports a page that paints an image the record did not keep', () => {
		expect(keptImageMismatches({ '1': 2 }, [2, 1, 0])).toEqual([
			{ page: 2, expected: 0, actual: 1 }
		]);
	});

	it('reports a page that lost an image the record kept', () => {
		expect(keptImageMismatches({ '1': 2 }, [1, 0])).toEqual([{ page: 1, expected: 2, actual: 1 }]);
	});

	it('reports a kept page the document does not have', () => {
		expect(keptImageMismatches({ '1': 1, '9': 1 }, [1, 0])).toEqual([
			{ page: 9, expected: 1, actual: 0 }
		]);
	});
});

// A served document is read by other people's PDF viewers, not only ours, so it must carry nothing a viewer
// runs, launches, submits or unpacks. The scan reads PDF names in the raw bytes, which is where every
// dictionary sits once object streams are refused.
// A rate over only the chunks that carry an anchor cannot see anchors going missing: a rebuild that dropped them
// would shrink the measured set and pass. Every paged chunk of a served document is measured.
describe('highlightPopulation', () => {
	it('measures every paged chunk of a served document, one without an anchor as unanchored', () => {
		const chunks = [
			{ sourceId: 'a', page: 3, anchor: { exact: 'quoted' } },
			{ sourceId: 'a', page: 4 },
			{ sourceId: 'a', page: 5, anchor: { exact: '' } },
			{ sourceId: 'b', page: 1, anchor: { exact: 'not served' } },
			{ sourceId: 'a', anchor: { exact: 'no page' } }
		];
		const { anchored, unanchored } = highlightPopulation(chunks, new Set(['a']));
		expect(anchored.map((c) => c.page)).toEqual([3]);
		expect(unanchored.map((c) => c.page)).toEqual([4, 5]);
	});
});

describe('unlistedServedFiles', () => {
	const carried = [
		{
			commit: 'a1b2c3d',
			path: 'static/docs/tap_vet_centers.1dcfd966.pdf',
			sha256: 'aa'.repeat(32)
		},
		{ commit: 'e4f5a6b', path: 'static/docs/tap_vet_centers.d8b11a45.pdf', sha256: 'bb'.repeat(32) }
	];

	// A pull request publishes every commit it carries, so a served file any one of them holds is public even
	// when a later commit replaces it. Only the files the manifest at the head records were proven.
	it('lists each served file a commit carries that the manifest does not record', () => {
		expect(unlistedServedFiles(carried, new Set(['bb'.repeat(32)]))).toEqual([carried[0]]);
	});

	it('passes when the manifest records every carried file', () => {
		expect(unlistedServedFiles(carried, new Set(['aa'.repeat(32), 'bb'.repeat(32)]))).toEqual([]);
	});
});

describe('activeContentIn', () => {
	const NUL = String.fromCharCode(0);

	it('reports every name that makes a viewer run, fetch or unpack something', () => {
		const names = [
			'/JavaScript',
			'/JS',
			'/Launch',
			'/RichMedia',
			'/XFA',
			'/SubmitForm',
			'/ImportData',
			'/EmbeddedFiles',
			'/OpenAction',
			'/AA',
			'/GoToE',
			'/Sound',
			'/Movie'
		];
		for (const name of names) {
			expect(activeContentIn(`1 0 obj\n<< ${name} 2 0 R >>\nendobj\n`)).toEqual([name]);
		}
	});

	it('reports each name once, sorted, from a real action dictionary', () => {
		const raw = '<< /Type /Action /S /JavaScript /JS (app.alert(1)) /Next << /S /JavaScript >> >>';
		expect(activeContentIn(raw)).toEqual(['/JS', '/JavaScript']);
	});

	// An object stream hides the dictionaries inside it from this scan, so a file with one cannot be cleared.
	it('reports an object stream', () => {
		expect(activeContentIn('5 0 obj\n<< /Type /ObjStm /N 3 /First 12 >>\nstream\n')).toEqual([
			'/ObjStm'
		]);
	});

	// A reader finds an object inside an object stream only through a cross-reference stream, and one needs no
	// /Type to be read - so a file indexed by one, or by a hybrid reference to one, cannot be cleared either.
	it('reports a cross-reference stream and a hybrid reference to one', () => {
		expect(activeContentIn('9 0 obj\n<< /Type /XRef /W [1 4 1] /Size 10 >>\nstream\n')).toEqual([
			'/XRef'
		]);
		expect(activeContentIn('trailer\n<< /Size 10 /XRefStm 812 >>\n')).toEqual(['/XRefStm']);
	});

	it('reports a file attached through an annotation, and media', () => {
		const attached =
			'<< /Type /Annot /Subtype /FileAttachment /FS << /Type /Filespec /EF << /F 9 0 R >> >> >>\n' +
			'9 0 obj\n<< /Type /EmbeddedFile /Length 3 >>\nstream\n';
		expect(activeContentIn(attached)).toEqual(['/EF', '/EmbeddedFile', '/FileAttachment']);
		expect(activeContentIn('<< /Subtype /Screen /A << /S /Rendition /R 4 0 R >> >>')).toEqual([
			'/Rendition',
			'/Screen'
		]);
		expect(activeContentIn('<< /Subtype /3D /3DD 5 0 R >>')).toEqual(['/3D']);
	});

	// A link that opens another file points outside the document - in the captures, at a designer's own computer.
	it('reports a link that opens another file', () => {
		expect(activeContentIn('<< /S /GoToR /F (x.pdf) /D [0 /Fit] >>')).toEqual(['/GoToR']);
	});

	it('matches whole names only', () => {
		const raw = '<< /JSON 1 /AAPL 2 /JavaScripts 3 /XFAx 4 /Soundtrack 5 /OpenActions 6 >>';
		expect(activeContentIn(raw)).toEqual([]);
	});

	// PDF names are case-sensitive: a viewer looks up /JavaScript exactly, so /javascript is another key.
	it('compares names case-sensitively', () => {
		expect(activeContentIn('<< /javascript 1 /js 2 /aa 3 >>')).toEqual([]);
	});

	it('ends a name at every PDF delimiter', () => {
		for (const next of ['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']) {
			expect(activeContentIn(`/AA${next}`)).toEqual(['/AA']);
		}
	});

	// NUL is white space in PDF syntax, so a name followed by one is complete; a scan that ends names only at
	// the usual white space would read "/JS" + NUL as a longer, harmless name.
	it('ends a name at every PDF white-space character, NUL included', () => {
		for (const next of [NUL, '\t', '\n', '\f', '\r', ' ']) {
			expect(activeContentIn(`/JS${next}(x)`)).toEqual(['/JS']);
		}
	});

	it('reports a name at the very end of the bytes', () => {
		expect(activeContentIn('<< /S /Launch')).toEqual(['/Launch']);
	});

	// A name may spell any character as # and two hex digits; a viewer decodes them before looking it up.
	it('decodes hex escapes before comparing', () => {
		expect(activeContentIn('<< /S /J#61vaScript /#4A#53 (x) /Obj#53tm 1 >>')).toEqual([
			'/JS',
			'/JavaScript',
			'/ObjStm'
		]);
	});

	it('passes a link annotation and ordinary page dictionaries', () => {
		const raw =
			'<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /URI /URI (https://www.va.gov/) >> >>\n' +
			'<< /Type /Page /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
		expect(activeContentIn(raw)).toEqual([]);
	});
});

// Both raw-byte scans - active content here, JPEG 2000 in the verifier - read names through this one reader,
// so a name that one scan sees whole the other cannot see as a longer, unknown name.
describe('pdfNamesIn', () => {
	const NUL = String.fromCharCode(0);

	it('ends a name at a NUL byte, which PDF counts as white space', () => {
		expect(pdfNamesIn(`<< /Filter /JPXDecode${NUL}/Width 1 >>`).has('/JPXDecode')).toBe(true);
	});

	it('decodes a name spelled with # hex escapes', () => {
		expect(pdfNamesIn('<< /Filter /JPX#44ecode >>').has('/JPXDecode')).toBe(true);
	});
});

// The reader's line over a served document says it is without most of its pictures when the document kept any,
// and without its pictures otherwise. The list is read from what publishing recorded of each file.
describe('documentsWithPictures', () => {
	it('names every served document that kept a picture, and only those, in order', () => {
		expect(
			documentsWithPictures([
				{ sourceId: 'tap_c', keptImages: 12 },
				{ sourceId: 'tap_b', keptImages: 0 },
				{ sourceId: 'tap_a', keptImages: 1 }
			])
		).toEqual(['tap_a', 'tap_c']);
	});

	it('names none when no document kept a picture', () => {
		expect(documentsWithPictures([{ sourceId: 'tap_a', keptImages: 0 }])).toEqual([]);
	});
});
