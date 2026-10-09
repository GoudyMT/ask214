/* eslint-disable svelte/prefer-svelte-reactivity -- every Date here is read once and never changed; the reactivity comes from the subscription, which re-reads the clock */
import { createSubscriber } from 'svelte/reactivity';

/**
 * Milliseconds from `now` to the next local midnight. The next midnight is built from the local calendar fields, not
 * by adding 24 hours, so the day the clocks change is 23 or 25 hours long.
 */
export function msToNextLocalMidnight(now: Date): number {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
}

/**
 * The device clock as a reactive read, for a page that works out dates from today. A page left open past midnight
 * must see the new day everywhere it derives from today, so the view and an add made from it agree on which day it is.
 *
 * Reading `now` inside a derived or an effect subscribes it; one timer, armed for the next local midnight, tells every
 * reader to read again, and it is armed again each time it fires. The timer stops with the last reader.
 *
 * There is no visibility listener on purpose: a hidden page relocks and reads again on unlock, and a timer that came
 * due while the device slept fires when it wakes.
 */
export class LocalToday {
	#subscribe = createSubscriber((update) => {
		let timer: ReturnType<typeof setTimeout>;
		const arm = (): void => {
			timer = setTimeout(() => {
				update();
				arm();
			}, msToNextLocalMidnight(new Date()));
		};
		arm();
		return () => clearTimeout(timer);
	});

	/** The clock at the moment of the read. */
	get now(): Date {
		this.#subscribe();
		return new Date();
	}
}
