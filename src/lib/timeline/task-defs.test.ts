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

	it('gives every phase bucket a non-empty short label for the chip-strip', () => {
		// The full bucket.label is too long for a nav chip, so each bucket carries a compact
		// shortLabel. Well-formedness only (per this file's philosophy): editing the text keeps it green.
		for (const bucket of PHASE_BUCKETS) {
			expect(bucket.shortLabel).toBeTruthy();
			expect(typeof bucket.shortLabel).toBe('string');
		}
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

	// Content placement: medical documentation must START early - it belongs in
	// the 18-12mo phase, not 12-6mo, so the VA-claim record has the longest runway. Buckets are
	// half-open [startOffset, endOffset), so the recommended offset must sit inside 18-12mo.
	it('schedules "start documenting medical conditions" in the 18-12 month phase', () => {
		const task = TASK_DEFS.find((t) => t.id === 'document-medical');
		const bucket = PHASE_BUCKETS.find((b) => b.id === '18-12mo');
		expect(task).toBeDefined();
		expect(bucket).toBeDefined();
		if (!task || !bucket) return;
		const offset = task.recommendedOffset ?? task.windowStart;
		expect(offset).toBeGreaterThanOrEqual(bucket.startOffset);
		expect(offset).toBeLessThan(bucket.endOffset);
	});
});
