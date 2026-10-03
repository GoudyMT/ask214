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

	it('gives every task a kind, and firm tasks a note for after their date', () => {
		for (const t of TASK_DEFS) {
			expect(['soft', 'required', 'closes']).toContain(t.kind);
			if (t.kind === 'soft') {
				expect(t.afterNote).toBeUndefined();
				expect(t.finalEnd).toBeUndefined();
			} else {
				expect(t.afterNote?.length ?? 0).toBeGreaterThan(0);
			}
		}
	});

	it('gives a two-edge task a later final edge and a note for between the edges', () => {
		for (const t of TASK_DEFS.filter((d) => d.finalEnd !== undefined)) {
			expect(t.kind).toBe('closes');
			expect(t.finalEnd).toBeGreaterThan(t.windowEnd);
			expect(t.changeNote?.length ?? 0).toBeGreaterThan(0);
		}
	});

	// 38 CFR 14.629: the app states public facts and points to official help; it never tells a person what
	// they qualify for.
	it('keeps every user-facing line free of personal eligibility claims', () => {
		const PERSONAL = /\byou (qualify|are eligible|will (get|receive))\b/i;
		for (const t of TASK_DEFS) {
			for (const line of [t.title, t.why, t.afterNote ?? '', t.changeNote ?? '']) {
				expect(line).not.toMatch(PERSONAL);
			}
		}
	});
});
