export type TimelineAccess = 'ready' | 'loading' | 'failed' | 'locked';
export type PanelAccess =
	'ready' | 'loading' | 'calendar-failed' | 'timeline-failed' | 'timeline-locked';

// The flags the stores expose, each optional but `ready`: null is a store the app has not handed over yet.
type Flags = { ready: boolean; failed?: boolean; locked?: boolean } | null | undefined;

/**
 * Why a store's record is or is not usable. A failure outranks a lock (a store whose read failed has nothing to
 * unlock), and both outrank loading: "not loaded" alone means the first read has not finished, which a page waits out.
 */
export function timelineAccess(t: Flags): TimelineAccess {
	if (t?.failed) return 'failed';
	if (t?.locked) return 'locked';
	if (!t?.ready) return 'loading';
	return 'ready';
}

/**
 * Why the calendar add is or is not allowed: it needs both the exclusion set and the task state. The timeline's
 * reasons come first because the user can act on them (unlock, reload) while a failed calendar read only says reload.
 */
export function panelAccess(t: Flags, c: Flags): PanelAccess {
	const timeline = timelineAccess(t);
	if (timeline === 'locked') return 'timeline-locked';
	if (timeline === 'failed') return 'timeline-failed';
	if (c?.failed) return 'calendar-failed';
	if (timeline === 'loading' || !c?.ready) return 'loading';
	return 'ready';
}
