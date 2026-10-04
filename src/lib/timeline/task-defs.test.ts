import { describe, it, expect } from 'vitest';
import { TASK_DEFS, PHASE_BUCKETS } from './task-defs';
import { RESOURCES, TASK_AFTER_LINK } from '$lib/resources/resources';
import { DEVICE_HINT, IOS_APP_HINT } from '$lib/calendar/delivery';

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
	// they qualify for, are entitled to, or have left to act. Every line shown about a task is covered: its own
	// text, its What now link, the curated resources and the sentence under the calendar button.
	it('keeps every public line about a task free of personal eligibility claims', () => {
		const PERSONAL =
			/\byou(?:'re| are)? (?:qualify|eligible|entitled)\b|\byou will (?:get|receive)\b|\byou have \d+ days\b|\byou can get\b/i;
		const lines = [
			...TASK_DEFS.flatMap((t) => [t.title, t.why, t.afterNote ?? '', t.changeNote ?? '']),
			...Object.values(TASK_AFTER_LINK).map((link) => link.label),
			...RESOURCES.flatMap((r) => [r.title, r.description]),
			...[...Object.values(DEVICE_HINT), IOS_APP_HINT].map((hint) => `${hint.lead} ${hint.text}`)
		];
		expect(lines.length).toBeGreaterThan(200);
		for (const line of lines) expect(line).not.toMatch(PERSONAL);
	});
});

// Each firm deadline pinned to the public source it comes from, so a later edit cannot drift from the rule.
describe('firm deadlines match their official sources', () => {
	const at = (id: string) => TASK_DEFS.find((t) => t.id === id);

	it.each([
		// 10 USC 1142 - counseling "shall commence not later than 365 days before"
		['preseparation-counseling', 'required', -365, undefined],
		// militaryonesource.mil TAP - the Capstone "no later than 90 days before separation"
		['tap-capstone', 'required', -90, undefined],
		// va.gov pre-discharge claim - "between 180 to 90 days before you leave the military"
		['va-bdd-claim', 'closes', -90, undefined],
		// tricare.mil CHCBP - "enroll within 60 days of losing your eligibility for TRICARE"
		['tricare-elect', 'closes', 60, undefined],
		// va.gov VGLI - 240 days with no health questions; "within 1 year and 120 days"
		['vgli-convert', 'closes', 240, 485],
		// militaryonesource.mil - "those separating before retirement have 180 days"
		['hhg-counseling', 'closes', 180, undefined],
		// 38 CFR 3.400(b)(2)(i) - a claim "received within 1 year after separation" keeps the earliest effective
		// date. It is an effective-date rule, not a filing deadline, so the task is soft: no last day, never closed.
		['va-claim-fallback', 'soft', 365, undefined],
		// tricare.mil TAMP - a Selected Reservist "the day immediately following release"; affiliating later is still
		// possible, so the task is soft with its aim at separation.
		['reserve-affiliation', 'soft', 0, undefined]
	] as const)('%s is %s with its last day at %d', (id, kind, windowEnd, finalEnd) => {
		const t = at(id);
		expect(t?.kind).toBe(kind);
		expect(t?.windowEnd).toBe(windowEnd);
		expect(t?.finalEnd).toBe(finalEnd);
	});

	// Copy that has to carry the condition its source carries, so a later edit cannot drop it.
	it('keeps the conditions the sources state in the coverage, move, VGLI and TAP lines', () => {
		// tricare.mil: TAMP gives 180 more days of coverage, and the CHCBP window runs from the end of TAMP.
		expect(at('tricare-elect')?.why).toContain('TAMP');
		expect(at('tricare-elect')?.afterNote).toContain('TAMP');
		// militaryonesource.mil: "Final move entitlements vary ... confirm with your installation's Transportation Office".
		expect(at('hhg-counseling')?.why).toContain('confirm with your transportation office');
		// va.gov SGLI: a member totally disabled at separation keeps free SGLI longer, then VGLI is offered.
		expect(at('vgli-convert')?.afterNote).toContain('standard VGLI deadline');
		// militaryonesource.mil TAP: three mandatory courses.
		for (const course of [
			'Transition Day',
			'VA Benefits and Services',
			'Employment Fundamentals of Career Transition'
		]) {
			expect(at('tap-course')?.why).toContain(course);
		}
	});

	it('opens the Capstone at 12 months and Chapter 36 counseling 180 days before separation', () => {
		expect(at('tap-capstone')?.windowStart).toBe(-365);
		expect(at('va-career-guidance')?.windowStart).toBe(-180);
		expect(at('va-career-guidance')?.windowEnd).toBe(365);
	});
});
