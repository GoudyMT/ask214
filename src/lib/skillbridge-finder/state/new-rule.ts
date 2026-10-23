import type { Listing } from '../contract/listing';

export type NewContext = {
	/** The last two weekly pull dates from changes.json. */
	recentPullDates: readonly string[];
	baselineDate: string;
	openedIds: ReadonlySet<number>;
	/** Saved and compared ids. */
	keptIds: ReadonlySet<number>;
};

/** A program created longer than this before we first saw it is old stock that only just appeared. */
const MAX_DAYS_CREATED_BEFORE_SEEN = 30;
const MS_PER_DAY = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole days since 1970-01-01 for a YYYY-MM-DD date, computed in UTC; NaN when it is not a date. */
function days(date: string): number {
	const parts = DATE_RE.exec(date);
	if (parts === null) return NaN;
	return Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) / MS_PER_DAY;
}

/**
 * Whether a listing carries the New mark. Every date is the data's own (pull dates), never the device clock, so
 * New lasts two weekly updates for everyone alike.
 */
export function isNew(listing: Listing, ctx: NewContext): boolean {
	if (listing.fl <= ctx.baselineDate) return false;
	if (!ctx.recentPullDates.includes(listing.fl)) return false;
	if (ctx.openedIds.has(listing.i) || ctx.keptIds.has(listing.i)) return false;
	const age = days(listing.fl) - days(listing.dc);
	// NaN (an unreadable date) fails the comparison, so such a listing is never New.
	return Math.max(age, 0) <= MAX_DAYS_CREATED_BEFORE_SEEN;
}

/** Keep only ids that could still be New: older ones never can be again, so remembering them has no use. */
export function pruneSeen(
	seen: readonly number[],
	firstListed: ReadonlyMap<number, string>,
	recentPullDates: readonly string[]
): number[] {
	return seen.filter((id) => {
		const first = firstListed.get(id);
		return first !== undefined && recentPullDates.includes(first);
	});
}

/** The newest update date shown so far; it never moves back. */
export function nextLastSeen(current: string | undefined, shown: string): string {
	return current === undefined || shown > current ? shown : current;
}

/** True when the incoming update is older than the one already held. */
export function isRollback(held: string | undefined, incoming: string): boolean {
	return held !== undefined && incoming < held;
}
