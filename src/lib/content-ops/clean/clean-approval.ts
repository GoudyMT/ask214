export type CleanApproval = { decision: string; cleanedHash: string };
export type CleanedRef = { extractionHash: string; cleanedHash: string };

/**
 * True only when the cleaned output is derived from the current extraction AND approved as this
 * exact cleaned output. A cleaning-rules change leaves the extraction untouched but changes the
 * cleaned normalizedText, which changes cleanedHash - so a prior approval keyed to the old
 * cleanedHash fails closed here until a human reviews and re-approves the new cleaned output.
 *
 * Args:
 *     currentExtractionHash: The content_hash read live from the current extracted/<id>.json -
 *         never a cached or cross-referenced value, since a re-ingest can change it independently.
 *     cleaned: The cleaned artifact's own extraction reference plus a hash of its cleaned output,
 *         or null when no cleaned/<id>.json exists for this source at all.
 *     approval: The manifest's decision and cleanedHash for this source, or undefined when the
 *         manifest has never tracked this source.
 *
 * Returns:
 *     True iff cleaned is present, cleaned.extractionHash matches currentExtractionHash, and
 *     approval is an 'approved' decision whose cleanedHash matches cleaned.cleanedHash exactly.
 */
export function isCleanApproved(
	currentExtractionHash: string,
	cleaned: CleanedRef | null,
	approval: CleanApproval | undefined
): boolean {
	return (
		cleaned !== null &&
		cleaned.extractionHash === currentExtractionHash &&
		approval?.decision === 'approved' &&
		approval.cleanedHash === cleaned.cleanedHash
	);
}

/**
 * Extracted source ids that have no cleaned artifact. The chunker builds its worklist from the
 * cleaned/ directory, so a source that was extracted but never cleaned would be silently omitted from
 * the corpus rather than blocked - a completeness hole in the fail-closed gate. Chunking must refuse
 * to proceed while any of these exist, so a missing source fails loudly like an unapproved one does.
 *
 * Args:
 *     extractedIds: Source ids present in the extraction directory (the sources that must be covered).
 *     cleanedIds: Source ids that have a cleaned artifact on disk.
 *
 * Returns:
 *     The extractedIds, in order, that have no matching cleaned artifact.
 */
export function missingCleanedSources(
	extractedIds: string[],
	cleanedIds: Iterable<string>
): string[] {
	const cleaned = new Set(cleanedIds);
	return extractedIds.filter((id) => !cleaned.has(id));
}
