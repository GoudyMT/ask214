import { documentSourceId } from '$lib/ask/asset-cache';

export type DocumentState = 'saved' | 'updated' | 'unsaved';

/**
 * What this device holds of each served document, read from the paths in the asset cache.
 *
 * A document's served path carries a hash of its content, so a recapture ships it under a new path while the
 * old copy stays cached. That old copy is how an update is recognised: the current path is not held, but an
 * older one for the same source is. It is also listed as stale when the current copy IS held, so saving
 * again or removing the document clears every copy.
 *
 * @param cachedPaths The same-origin pathnames held in the asset cache.
 * @param documents Source id -> current served path, as the generated map gives it.
 * @returns Per shipped document, its state and the held copies that are not current. A held document this
 *   build does not ship, and anything outside `/docs/`, is ignored.
 */
export function documentStates(
	cachedPaths: readonly string[],
	documents: Readonly<Record<string, string>>
): Record<string, { state: DocumentState; stale: string[] }> {
	const held = cachedPaths.filter((path) => path.startsWith('/docs/'));
	const states: Record<string, { state: DocumentState; stale: string[] }> = {};
	for (const [sourceId, current] of Object.entries(documents)) {
		const copies = held.filter((path) => documentSourceId(path) === sourceId);
		const stale = copies.filter((path) => path !== current);
		const state = copies.includes(current) ? 'saved' : stale.length > 0 ? 'updated' : 'unsaved';
		states[sourceId] = { state, stale };
	}
	return states;
}
