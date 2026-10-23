import type { ChangesFile, IdsFile } from '../contract/listing';

export type SavedStatus = { kind: 'listed'; id: number } | { kind: 'missing'; since?: string };

/** A merge chain longer than this is not a real one. */
const MAX_ALIAS_STEPS = 50;

/**
 * The id a merged id ended up as, following the chain. A cycle (a damaged or hostile file) or a chain past
 * MAX_ALIAS_STEPS ends the walk where it stands instead of looping.
 */
export function resolveId(id: number, aliases: readonly [number, number][]): number {
	const next = new Map(aliases);
	const visited = new Set<number>([id]);
	let current = id;
	for (let step = 0; step < MAX_ALIAS_STEPS; step++) {
		const target = next.get(current);
		if (target === undefined || visited.has(target)) break;
		visited.add(target);
		current = target;
	}
	return current;
}

/**
 * Whether a saved program is still listed. Recomputed from the files each time and never remembered, so a program
 * that comes back is listed again. `since` is the pull date of the week that removed it, and is absent when no
 * published week names it.
 */
export function savedStatus(savedId: number, ids: IdsFile, changes?: ChangesFile): SavedStatus {
	const resolved = resolveId(savedId, ids.aliases);
	if (ids.ids.some(([id]) => id === resolved)) return { kind: 'listed', id: resolved };
	let since: string | undefined;
	for (const week of changes?.weeks ?? []) {
		const named = week.removed.includes(savedId) || week.removed.includes(resolved);
		if (named && (since === undefined || week.pullDate > since)) since = week.pullDate;
	}
	return since === undefined ? { kind: 'missing' } : { kind: 'missing', since };
}
