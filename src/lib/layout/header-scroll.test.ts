import { describe, it, expect } from 'vitest';
import { nextHeaderState, startHeaderState } from './header-scroll';

// The phone header slides away while a person reads down the page and comes back when they start to go up. These rows
// play a run of scroll positions through nextHeaderState, the way scroll events arrive.
const play = (from: number, ys: number[]) => ys.reduce(nextHeaderState, startHeaderState(from));
const hiddenAfter = (from: number, ys: number[]) => play(from, ys).hidden;

describe('nextHeaderState', () => {
	// A thumb resting on the screen or a small bounce must not make the header flicker.
	it('hides only after the page has moved more than 12 px down: 12 px keeps it, 13 px hides it', () => {
		expect(hiddenAfter(100, [104, 108, 112])).toBe(false);
		expect(hiddenAfter(100, [104, 108, 112, 113])).toBe(true);
	});

	it('brings the header back on a move of 4 px or more up: 3 px keeps it hidden, 4 px shows it', () => {
		const hidden = [120, 200, 300];
		expect(hiddenAfter(100, hidden)).toBe(true);
		expect(hiddenAfter(100, [...hidden, 297])).toBe(true);
		expect(hiddenAfter(100, [...hidden, 296])).toBe(false);
	});

	// Scrolling up in small steps is still scrolling up: the distance counts from where the page turned.
	it('adds up small moves in one direction, so two 2 px steps up show it', () => {
		expect(hiddenAfter(100, [120, 200, 300, 298])).toBe(true);
		expect(hiddenAfter(100, [120, 200, 300, 298, 296])).toBe(false);
	});

	// Whatever state it was in, the top of the page (or the pull past it that phones allow) has the header in place; the
	// 4 px up rule alone would leave it hidden when the last move to the top is shorter than that.
	it.each([0, -8])('shows the header when the page reaches %s', (y) => {
		const hiddenNearTop = { hidden: true, lastY: 2, anchorY: 2, dir: 1 as const };
		expect(nextHeaderState(hiddenNearTop, y).hidden).toBe(false);
	});

	// Down 8, back 2, down 8 is 14 px of net travel but never 13 px in one direction: a wobble, not a scroll down.
	it('counts the distance from the last turn, so a wobble does not hide it', () => {
		expect(hiddenAfter(100, [108, 106, 114])).toBe(false);
	});

	it('stays hidden through a wobble that never goes 4 px up', () => {
		expect(hiddenAfter(100, [120, 200, 300, 298, 300, 297, 300])).toBe(true);
	});

	it('changes nothing when the page has not moved', () => {
		const hidden = play(100, [120, 200, 300]);
		expect(nextHeaderState(hidden, 300)).toEqual(hidden);
	});
});
