import { DurableObject } from 'cloudflare:workers';
import { advance, isTripped, type BreakerState } from '../../../src/lib/ask/online/breaker-state';

const KEY = 'state';

// One global instance (getByName('global')) holds the day's neuron tally. SQLite-backed, strongly
// consistent, free-tier -- degrades-never-bills. The decision logic lives in the pure breaker-state
// unit; this is thin persistence. Durable Object methods are serialized per instance, so this
// check-then-write is atomic without explicit locking.
export class Breaker extends DurableObject {
	/**
	 * Check today's tally; if still under the safety line, reserve `estNeurons` for the embed about to
	 * run. Returns true when the caller must degrade (already over the line -- nothing reserved).
	 */
	async reserve(today: string, estNeurons: number): Promise<boolean> {
		const prev = (await this.ctx.storage.get<BreakerState>(KEY)) ?? null;
		if (isTripped(prev, today)) return true;
		await this.ctx.storage.put(KEY, advance(prev, today, estNeurons));
		return false;
	}
}
