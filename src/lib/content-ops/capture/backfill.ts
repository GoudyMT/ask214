export type BackfillInput = {
	contentHash: string;
	capturedPath: string;
	capturedAt: string;
	robotsAllowed: boolean;
};

/**
 * Return a copy of a `sources.yaml` entry with the A2 capture fields populated (A2-D5). Pure - the input
 * is not mutated and the actual YAML write is the build script's job; existing fields are preserved.
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
