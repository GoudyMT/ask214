import { describe, it, expect } from 'vitest';
import { buildLibraryManifest, type CapturedRecord } from './library-manifest';

const captured: CapturedRecord[] = [
	{
		source_id: 'va_pdf',
		content_type: 'pdf',
		served: true,
		content_hash: 'h1',
		byte_size: 1024,
		captured_at: '2026-06-20T00:00:00Z',
		served_path: 'static/corpus/library/h1.pdf'
	},
	{
		source_id: 'va_html',
		content_type: 'html',
		served: false,
		content_hash: 'h2',
		byte_size: 512,
		captured_at: '2026-06-20T00:00:00Z'
	}
];

describe('buildLibraryManifest', () => {
	it('emits a version-keyed manifest with per-file integrity entries', () => {
		const m = buildLibraryManifest(captured, '1.0');
		expect(m.corpusVersion).toBe('1.0');
		expect(m.entries).toEqual([
			{
				sourceId: 'va_pdf',
				contentType: 'pdf',
				served: true,
				servedPath: 'static/corpus/library/h1.pdf',
				contentHash: 'h1',
				byteSize: 1024,
				capturedAt: '2026-06-20T00:00:00Z'
			},
			{
				sourceId: 'va_html',
				contentType: 'html',
				served: false,
				contentHash: 'h2',
				byteSize: 512,
				capturedAt: '2026-06-20T00:00:00Z'
			}
		]);
	});

	it('omits servedPath entirely on a non-served entry (key absent, not undefined)', () => {
		const m = buildLibraryManifest(captured, '1.0');
		expect('servedPath' in m.entries[1]!).toBe(false);
	});
});
