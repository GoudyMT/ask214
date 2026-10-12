export type TimelineAccess = 'ready' | 'loading' | 'failed' | 'locked';
export type PanelAccess =
	'ready' | 'loading' | 'calendar-failed' | 'timeline-failed' | 'timeline-locked';

// The flags the stores expose, each optional but `ready`: null is a store the app has not handed over yet.
type Flags = { ready: boolean; failed?: boolean; locked?: boolean } | null | undefined;

/**
 * Why a store's record is or is not usable. A failure outranks a lock (a store whose read failed has nothing to
 * unlock), and both outrank loading: "not loaded" alone means the first read has not finished, which a page waits out.
 *
 * `opening` is the page's own Unlock still reading the stores: each stays locked (or keeps an old failure) until its own
 * read lands, so what it reports then is about to change and the page says loading instead.
 */
export function timelineAccess(t: Flags, opening = false): TimelineAccess {
	if (opening) return 'loading';
	if (t?.failed) return 'failed';
	if (t?.locked) return 'locked';
	if (!t?.ready) return 'loading';
	return 'ready';
}

/**
 * Why the calendar add is or is not allowed: it needs both the exclusion set and the task state. The timeline's
 * reasons come first because the user can act on them (unlock, reload) while a failed calendar read only says reload.
 */
export function panelAccess(t: Flags, c: Flags, opening = false): PanelAccess {
	if (opening) return 'loading';
	const timeline = timelineAccess(t);
	if (timeline === 'locked') return 'timeline-locked';
	if (timeline === 'failed') return 'timeline-failed';
	// A calendar left locked is not re-read on its own, so with no Unlock running it will not become ready: the same
	// line as a failed read, which also says to reload.
	if (c?.failed || c?.locked) return 'calendar-failed';
	if (timeline === 'loading' || !c?.ready) return 'loading';
	return 'ready';
}
