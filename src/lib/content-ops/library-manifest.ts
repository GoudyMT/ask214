/**
 * The docs-library manifest type + builder (producer-side). Distinct from the shipped
 * CorpusManifest (chunks): this is the version/integrity index for the CAPTURED ORIGINALS, served
 * same-origin and (later) consumed by the runtime sync cycle. Pure builder; no IO.
 */
export type DocsLibraryManifest = {
	corpusVersion: string;
	entries: Array<{
		sourceId: string;
		contentType: 'pdf' | 'html';
		served: boolean;
		servedPath?: string; // present iff served (cleared PDFs); same-origin, content-addressed
		contentHash: string; // sha256 of the RAW original bytes (audit + update-detection)
		byteSize: number;
		capturedAt: string;
	}>;
};

/** One captured-original record the build feeds in (the subset the manifest builder consumes). */
export type CapturedRecord = {
	source_id: string;
	content_type: 'pdf' | 'html';
	served: boolean;
	served_path?: string;
	content_hash: string;
	byte_size: number;
	captured_at: string;
};

export function buildLibraryManifest(
	captured: CapturedRecord[],
	corpusVersion: string
): DocsLibraryManifest {
	return {
		corpusVersion,
		entries: captured.map((c) => {
			const entry: DocsLibraryManifest['entries'][number] = {
				sourceId: c.source_id,
				contentType: c.content_type,
				served: c.served,
				contentHash: c.content_hash,
				byteSize: c.byte_size,
				capturedAt: c.captured_at
			};
			if (c.served && c.served_path) entry.servedPath = c.served_path;
			return entry;
		})
	};
}
