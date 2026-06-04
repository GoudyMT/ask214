import { describe, it, expect } from 'vitest';
import { TASK_DEFS, PHASE_BUCKETS } from './task-defs';

// Well-formedness guards for the seed: these pass for ANY valid seed, so editing the
// task CONTENT (titles, windows, why/value, gates) keeps them green as long as the
// shape stays valid.

describe('task-defs seed', () => {
	it('has unique task ids', () => {
		const ids = TASK_DEFS.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('has valid windows (start <= end) with the recommended offset inside the window', () => {
		for (const t of TASK_DEFS) {
			expect(t.windowStart).toBeLessThanOrEqual(t.windowEnd);
			const rec = t.recommendedOffset ?? t.windowStart;
			expect(rec).toBeGreaterThanOrEqual(t.windowStart);
			expect(rec).toBeLessThanOrEqual(t.windowEnd);
		}
	});

	it('orders phase buckets furthest-out first (strictly increasing startOffset)', () => {
		const offsets = PHASE_BUCKETS.map((b) => b.startOffset);
		expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
		expect(new Set(offsets).size).toBe(offsets.length);
	});

	it('places every task inside the bucketed runway', () => {
		const first = PHASE_BUCKETS.at(0);
		const last = PHASE_BUCKETS.at(-1);
		expect(first).toBeDefined();
		expect(last).toBeDefined();
		if (!first || !last) return;
		for (const t of TASK_DEFS) {
			const rec = t.recommendedOffset ?? t.windowStart;
			expect(rec).toBeGreaterThanOrEqual(first.startOffset);
			expect(rec).toBeLessThan(last.endOffset);
		}
	});
});
