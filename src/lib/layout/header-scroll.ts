// The one spelling of the phone width in script. CSS media queries cannot read a variable, so the styles that go with
// it (the bottom bar, the header menu, the header's hiding) repeat the same 599.98px.
export const PHONE_QUERY = '(max-width: 599.98px)';

// Hysteresis for the phone header: only a clear move down hides it, and a short move up brings it back, so a resting
// thumb or a bounce at the end of a fling does not make it flicker.
export const HIDE_AFTER_PX = 12;
export const SHOW_AFTER_PX = 4;

/**
 * `anchorY` is where the page last turned round and `dir` the way it is moving (1 down, -1 up, 0 not yet moved):
 * the distances are counted from that turn, not from the previous event, so many small steps add up.
 */
export type HeaderState = { hidden: boolean; lastY: number; anchorY: number; dir: -1 | 0 | 1 };

export function startHeaderState(y: number): HeaderState {
	return { hidden: false, lastY: y, anchorY: y, dir: 0 };
}

/** The state after the page scrolls to `y`. At the top of the page (or pulled past it) the header is always shown. */
export function nextHeaderState(state: HeaderState, y: number): HeaderState {
	if (y <= 0) return startHeaderState(y);
	if (y === state.lastY) return state;
	const dir = y > state.lastY ? 1 : -1;
	const anchorY = dir === state.dir ? state.anchorY : state.lastY;
	const hidden =
		dir === 1
			? state.hidden || y - anchorY > HIDE_AFTER_PX
			: state.hidden && anchorY - y < SHOW_AFTER_PX;
	return { hidden, lastY: y, anchorY, dir };
}
