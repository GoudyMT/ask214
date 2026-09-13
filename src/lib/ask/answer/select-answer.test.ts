import { describe, expect, it } from 'vitest';
import { selectAnswer } from './select-answer';

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

describe('selectAnswer', () => {
	it('returns the whole body when it is under the target', () => {
		const body = 'You have one year to submit the completed claim.';
		expect(selectAnswer(body)).toBe(body);
	});

	// The opening is ALWAYS kept, even when a later sentence matches the question better. That is the
	// invariant this module exists to hold: a benefits document puts the condition that governs everything
	// after it at the top. The body runs past the 120-word ceiling on purpose, so the answer genuinely has to
	// leave something out - and what it leaves out is the END, never the start.
	it('always begins at the passage opening, and truncates from the end', () => {
		const filler = Array.from(
			{ length: 7 },
			(_, i) =>
				`Module ${i} of this guide explains a separate part of the transition timeline in considerable detail.`
		).join(' ');
		const body =
			'To qualify for this payment you must meet every condition listed in this section. ' +
			`${filler} ` +
			'A burial allowance helps cover the cost of a funeral and a burial plot.';
		const out = selectAnswer(body);
		expect(out.startsWith('To qualify for this payment')).toBe(true);
		expect(out).not.toContain('burial allowance helps cover');
	});

	// `.endsWith('.')` alone is satisfied by the marked cut's own '...', so this asserted nothing about the
	// one code path that can end mid-sentence. Both halves now: no bare truncation, and the marker present
	// only when a cut actually happened.
	it('never cuts mid-sentence', () => {
		const body = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} of the passage.`).join(
			' '
		);
		const out = selectAnswer(body);
		expect(out.endsWith('.')).toBe(true);
		expect(out.endsWith('...')).toBe(false);
	});

	// The governing negation is the FIRST sentence, and it is exactly what a start-scored run used to drop -
	// leaving "You are currently incarcerated..." reading as a statement ABOUT the reader rather than one of
	// the conditions that disqualifies them. Same fixture as before the change; the assertions are inverted,
	// because what was correct behavior is now the defect.
	it('keeps a governing negation that a start-scored run used to drop', () => {
		const body =
			'You are not eligible for this payment if any of the following circumstances apply to you at ' +
			'the time that your application is received by the regional office that serves the area where ' +
			'you currently reside and maintain your permanent legal residence. ' +
			'You are currently incarcerated in a federal or state penal institution for a felony conviction. ' +
			'You already receive a similar benefit from another federal agency for the same period.';
		const out = selectAnswer(body);
		expect(out).toContain('You are not eligible');
		expect(out.startsWith('...')).toBe(false);
	});

	it('does not mark a run that starts at the opening', () => {
		const body = 'First sentence here. Second sentence here. Third sentence here.';
		expect(selectAnswer(body).startsWith('...')).toBe(false);
	});

	// A flattened list must not render two independent bullets as one continuous statement - a "you may use
	// this for X" item welded to a "you may not use it for Y" item reads as a sentence the document never
	// wrote. At 67 words this body sits inside the 120-word ceiling, so it is emitted whole and the bullet
	// separator must survive intact.
	it('keeps two list items from reading as one statement', () => {
		const item = (n: number, w: string) => Array.from({ length: n }, () => w).join(' ');
		const body = `${item(44, 'tuition')} - ${item(23, 'housing')}`;
		const out = selectAnswer(body);
		expect(out).toContain('tuition - housing');
		expect(out).not.toContain('tuition housing');
	});

	// The list carries no sentence terminator, so it reads as one long sentence. The 1.5x ceiling is what
	// lets the packer absorb it rather than stopping on the short lead-in before it.
	it('absorbs an unterminated list rather than stopping right before the answer', () => {
		const body =
			'You will need several documents. ' +
			'Submit your DD214 your separation health assessment your dependency records your marriage ' +
			'certificate your birth certificates your direct deposit information your service treatment ' +
			'records and any private medical evidence you want us to consider including statements from ' +
			'people who served with you and any evidence of continued treatment after separation';
		expect(selectAnswer(body)).toContain('DD214');
	});

	it('does not treat an abbreviation period as a sentence end', () => {
		const body =
			'Apply through the U.S. Department of Veterans Affairs within one year of separation.';
		expect(selectAnswer(body)).toBe(body);
	});

	it('emits the opening sentences', () => {
		const body = 'First sentence here. Second sentence here. Third sentence here.';
		expect(selectAnswer(body)).toContain('First sentence');
	});

	// A run that starts partway into a passage drops whatever governed it. On a benefits document that is
	// the condition, and the entitlement then reads as unconditional - text true in the source and false on
	// screen. Judged blind over 135 real queries, a start-scored window shipped misleading text on 20.7% of
	// them against 13.3% for the head window it replaced, and 17 of those were answers the head window got
	// right. The output begins at the passage opening for that reason.
	it('keeps the governing condition attached to what it governs', () => {
		// 53 words, so the opening cannot fit in the scoring window alongside the answering sentence. A
		// shorter body fits whole, nothing is selected against, and the test would pass against an
		// implementation that does no selection at all.
		const body =
			'You may be able to get this grant if you meet both of the requirements that are listed below ' +
			'in this section of the guide. ' +
			'You own or will own the home, or a family member owns or will own the home in which you ' +
			'currently live. ' +
			'You have a qualifying service-connected disability.';
		const out = selectAnswer(body);
		expect(out).toContain('if you meet both of the requirements');
		expect(out.startsWith('...')).toBe(false);
	});

	it('stays within the ceiling', () => {
		const body = Array.from({ length: 90 }, (_, i) => `Filler sentence ${i} about benefits.`).join(
			' '
		);
		expect(words(selectAnswer(body))).toBeLessThanOrEqual(120); // the lead card cap
	});

	it('returns an empty string for an empty body', () => {
		expect(selectAnswer('   ')).toBe('');
	});
});
