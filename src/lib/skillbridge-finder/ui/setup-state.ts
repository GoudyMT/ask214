import type { FinderFilters, FinderSetup } from '../state/types';

/**
 * Whether the person has been through setup. The record keeps no separate flag: every save from the setup screen
 * writes both boxes as true or false, so a setup that was skipped is still not empty, and only a record never set up
 * has nothing in it.
 */
export function isSetUp(setup: FinderSetup): boolean {
	return Object.keys(setup).length > 0;
}

/**
 * The saved filters with the two the setup screen asks for (format and field) replaced by its answer; the others
 * (branch, length, kind) are the person's from the list's filter sheet, and stay as they were.
 */
export function withSetupChoices(
	current: FinderFilters,
	choices: Pick<FinderFilters, 'delivery' | 'industries'>
): FinderFilters {
	const next: FinderFilters = { ...current };
	delete next.delivery;
	delete next.industries;
	return { ...next, ...choices };
}
