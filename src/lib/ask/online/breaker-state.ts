// Pure daily-counter state for the neuron circuit-breaker. The Durable Object persists this; the logic
// lives here so it is node-testable -- accumulate spend within a UTC day, reset on rollover, and decide
// whether the online path degrades.
import { shouldDegrade } from './budget';

export interface BreakerState {
	day: string; // UTC date, 'YYYY-MM-DD'
	spent: number; // neurons counted today
}

/** Fold `addNeurons` into the running tally, starting fresh when the UTC day rolls over. */
export function advance(
	prev: BreakerState | null,
	today: string,
	addNeurons: number
): BreakerState {
	if (prev === null || prev.day !== today) return { day: today, spent: addNeurons };
	return { day: today, spent: prev.spent + addNeurons };
}

/** Whether the online path should degrade now -- only when today's tally has crossed the safety line. */
export function isTripped(state: BreakerState | null, today: string): boolean {
	if (state === null || state.day !== today) return false;
	return shouldDegrade(state.spent);
}
