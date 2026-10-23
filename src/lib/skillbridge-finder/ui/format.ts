import { BRANCHES, type Listing } from '../contract/listing';
import { STATE_NAMES } from '../search/state-names';
import { placement } from '../state/distance';

/** The words a card uses for a listing's facts. Pure, so each wording is held by a plain test. */

/** Where the program is: a city and its distance, a count of states, Online, or what is known of a missing place. */
export function placeLine(listing: Listing, miles?: number): string {
	const where = placement(listing);
	if (where.kind === 'remote') return 'Online';
	if (where.kind === 'multi') return `Offered in ${where.states} states`;
	const state = listing.s;
	if (state === undefined) return 'Location not listed';
	if (listing.c === undefined) return `${STATE_NAMES[state]}, no city listed`;
	const away = where.kind === 'point' && miles !== undefined ? ` - ${Math.round(miles)} mi` : '';
	return `${listing.c}, ${state}${away}`;
}

export function lengthLine(listing: Listing): string {
	return listing.d === undefined ? 'Length not listed' : `${listing.d} days`;
}

export function branchesLine(listing: Listing): string {
	if (listing.b.length === 0) return 'Any branch';
	if (BRANCHES.every((branch) => listing.b.includes(branch))) return 'All branches';
	return listing.b.join(', ');
}

export function jobCodesLine(listing: Listing): string {
	if (listing.oc === 'all') return 'Open to all occupations';
	return listing.oc !== undefined && listing.oc.length > 0
		? listing.oc.join(', ')
		: 'No codes listed';
}

/**
 * The address a link may point at: an https one, built by the URL parser, with no login in it. Anything else (a script
 * or data address, plain http, text that is no address) is refused, so a program's own text never becomes a link that
 * runs or leaks.
 */
export function safeHttps(raw: string | undefined): URL | null {
	if (raw === undefined) return null;
	try {
		const url = new URL(raw);
		return url.protocol === 'https:' && url.username === '' && url.password === '' ? url : null;
	} catch {
		return null;
	}
}

/** A mailto link whose whole address is encoded, so a `?bcc=` or `&body=` in the text stays part of the address. */
export function mailtoHref(email: string): string {
	return `mailto:${encodeURIComponent(email)}`;
}
