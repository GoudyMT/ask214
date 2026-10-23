import type { HomeRow } from '$lib/timeline/home-glance';

/** Everything the row may read. Nothing here goes anywhere but the row this returns. */
export type FinderHomeInput = {
	unlocked: boolean;
	online: boolean;
	setUp: boolean;
	missedWeeks: number;
	newCount: number;
	nearCount: number;
	/** The place the person set, worded for a sentence ("21046", "Maryland"); null with none. */
	placeLabel: string | null;
};

const NAME = 'SkillBridge';
// Past this many weekly updates missed, "new" no longer means this week and the row says nothing.
const MAX_MISSED_WEEKS = 4;

/**
 * SkillBridge's row on Home, or null when it has nothing true to say: the finder is not set up, the device is offline
 * (the weekly news could not be checked), or too many weekly updates were missed. Locked, the row shows no count and
 * no place: both come from the person's choices, which stay behind the lock.
 */
export function finderHomeRow(input: FinderHomeInput): HomeRow | null {
	if (!input.setUp || !input.online || input.missedWeeks > MAX_MISSED_WEEKS) return null;
	if (!input.unlocked) return { name: NAME, detail: 'Unlock to see what is new' };

	const near =
		input.placeLabel !== null && input.nearCount > 0
			? `${input.nearCount} near ${input.placeLabel}`
			: null;
	if (input.newCount <= 0) return { name: NAME, detail: near ?? 'No new programs this week' };
	return { name: NAME, count: `${input.newCount} new`, detail: near ?? 'New programs this week' };
}
