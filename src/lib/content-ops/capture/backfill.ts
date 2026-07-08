export type BackfillInput = {
	contentHash: string;
	capturedPath: string;
	capturedAt: string;
	robotsAllowed: boolean;
};

/**
 * Return a copy of a `sources.yaml` entry with the capture fields populated. Pure - the input is not
 * mutated and the actual YAML write is the caller's job; existing fields are preserved.
 */
export function backfillCaptureFields(
	entry: Record<string, unknown>,
	r: BackfillInput
): Record<string, unknown> {
	return {
		...entry,
		content_hash: r.contentHash,
		captured_path: r.capturedPath,
		captured_at: r.capturedAt,
		robots_allowed: r.robotsAllowed
	};
}

/** The source entry's current capture state, read from `sources.yaml` (values are `unknown` until checked). */
export type ExistingCaptureState = { content_hash?: unknown; captured_at?: unknown };

/** A fresh capture result for one source: the content hash plus its content type. */
export type IncomingCapture = {
	contentHash: string;
	contentType: 'pdf' | 'html';
	sourceUpdatedDate?: string;
};

/**
 * Resolve the four capture fields for one source, idempotently. `captured_at` refreshes to `now` only
 * when the content changed - a new or different hash, or a prior partial backfill that left no timestamp; an
 * unchanged hash keeps its existing `captured_at`, so a re-run is a no-op. `captured_path` is the
 * content-addressed audit-copy path; `robots_allowed` is always true (a disallowed source fails closed
 * before capture, so anything with an artifact was allowed).
 */
export function resolveBackfill(
	existing: ExistingCaptureState,
	incoming: IncomingCapture,
	now: string
): BackfillInput {
	const unchanged =
		existing.content_hash === incoming.contentHash &&
		typeof existing.captured_at === 'string' &&
		existing.captured_at.length > 0;
	return {
		contentHash: incoming.contentHash,
		capturedPath: `content-ops/captures/${incoming.contentHash}.${incoming.contentType}`,
		capturedAt: unchanged ? (existing.captured_at as string) : now,
		robotsAllowed: true
	};
}
