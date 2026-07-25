/** A manual/un-fetchable source and the staged file a human must place for ingest to run. */
export type ManualSource = { sourceId: string; expectedPath: string };

export type PlacementResult = { ok: boolean; missing: ManualSource[] };

/**
 * Confirms every manual source's expected staged file is present. Pure: the orchestrator reads the
 * filesystem into `present` (the set of staged paths that exist) and does the fail-closed exit; this
 * returns which manual sources have no placed file so the caller can name them precisely.
 *
 * Args:
 *     manualSources: the registry's un-fetchable sources + the exact path each staged file must have.
 *     present: the set of staged file paths that actually exist on disk.
 *
 * Returns:
 *     ok=true with an empty list when all present; otherwise ok=false and the missing sources.
 */
export function validatePlacement(
	manualSources: ManualSource[],
	present: Set<string>
): PlacementResult {
	const missing = manualSources.filter((m) => !present.has(m.expectedPath));
	return { ok: missing.length === 0, missing };
}
