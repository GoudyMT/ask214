import type { HomeRow } from './home-glance';

/**
 * Fetches the code behind Home's timeline row: its task list and date rules. Home calls it only for someone with a
 * profile, so a first visit downloads none of it.
 */
export const loadHomeGlance = () => import('./home-glance');

/** The row when the timeline cannot be read here: no count, and where to go instead. Kept here so Home can show it when the code itself fails to arrive. */
export const FAILED_ROW: HomeRow = {
	name: 'Your timeline',
	detail: 'Could not load it here - open the Timeline'
};
