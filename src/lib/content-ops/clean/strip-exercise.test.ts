import { describe, it, expect } from 'vitest';

// U+2022 BULLET, from its code point so this file stays pure ASCII.
const LIST_BULLET = String.fromCharCode(0x2022);
import { stripExercise } from './strip-exercise';

// Non-ASCII rebuilt from char codes so this file stays ASCII-only, per the project's character rule.
const APOSTROPHE = String.fromCharCode(0x2019); // U+2019 right single quote, an apostrophe in the source PDF

// Verbatim from content-ops/cleaned/tap_dol_efct.json block 117, page 123 - the one block in the corpus
// that is real guidance AND a graded exercise. classifyBlock deliberately keeps it (its exercise marker
// trails rather than opens), so this is the unit that has to separate the two halves.
const MIXED_BLOCK =
	'EFCT PARTICIPANT GUIDE | SECTION 7 | PAGE 123 JOB OFFERS Congratulations! You finished the final ' +
	'interview, and they offered you the job. Have you had an opportunity to see a written job offer? ' +
	'Maybe you have negotiated a job salary and benefits. Let' +
	APOSTROPHE +
	's start with what you already know about job offers and salary negotiation. ' +
	'JOB OFFER and SALARY NEGOTIATION QUIZ TRUE FALSE 1. A job offer will always be provided in writing. ' +
	'2. In a salary negotiation, you can ask to negotiate benefits as well as your wage or salary. ' +
	'3. Every job offer can be negotiated. 4. The candidate starts the negotiation. ' +
	'10. You may be able to negotiate your start date. ACTIVITY 7.2: Job Offer Quiz Consider the 10 ' +
	'questions below. Mark each as True or False. What do you think?';

describe('stripExercise', () => {
	it('removes the quiz run and keeps the guidance that precedes it', () => {
		const result = stripExercise(MIXED_BLOCK);
		expect(result).toContain('You finished the final interview, and they offered you the job.');
		expect(result).toContain('what you already know about job offers and salary negotiation.');
		expect(result).not.toContain('A job offer will always be provided in writing');
		expect(result).not.toContain('ACTIVITY 7.2');
	});

	// The clean stage's own invariant: every surviving block must remain an in-order verbatim substring
	// of the re-derived normalizedText (cleanExtraction asserts this and throws E_CLEAN_INVARIANT). A
	// strip that rewrites or re-spaces surviving characters breaks the chunk stage's offset mapping.
	it('leaves the surviving text byte-verbatim, not rewritten', () => {
		const result = stripExercise(MIXED_BLOCK);
		expect(MIXED_BLOCK).toContain(result);
	});

	// The false statements sit BEFORE the "Mark each as True or False" instruction in the block, so a
	// rule that cut only from the instruction onward would leave every false claim in place. Cutting
	// from the quiz heading is what actually removes them.
	it('cuts from the quiz heading, not from the instruction that follows the statements', () => {
		const result = stripExercise(MIXED_BLOCK);
		expect(result).not.toContain('JOB OFFER and SALARY NEGOTIATION QUIZ');
		expect(result.trim().endsWith('about job offers and salary negotiation.')).toBe(true);
	});

	it('returns an ordinary content block unchanged', () => {
		const text =
			'Capstone and Warm Handovers After completing all required components of the ITP, you are ' +
			'required to attend a Capstone event which occurs no later than 90 days before transition.';
		expect(stripExercise(text)).toBe(text);
	});

	// "Quiz" as a plain noun. The VA Self-Check Quiz is a real resource a veteran can go and take, so a
	// rule keying on the word rather than the TRUE/FALSE grid form would delete a mental-health referral.
	it('does not cut prose that merely mentions a real quiz', () => {
		const text =
			'Take a Free Self-Check VA and its partners have developed a quiz to help Veterans learn if ' +
			'stress and depression might be affecting them The Self-Check Quiz is a safe, easy and ' +
			'confidential resource';
		expect(stripExercise(text)).toBe(text);
	});

	it('returns an empty string unchanged', () => {
		expect(stripExercise('')).toBe('');
	});

	it('walks back only to the nearest structural boundary, not across a whole list', () => {
		// The cut starts at the quiz HEADING, which carries no sentence terminator of its own. Walking
		// back to find it must stop at the previous list item as well as at the previous sentence, or a
		// checklist sitting between the last full stop and the heading is swallowed with the exercise.
		const text =
			'Review the written offer carefully. JOB OFFER CHECKLIST Before you accept confirm each item ' +
			`${LIST_BULLET} Base salary and pay schedule ` +
			`${LIST_BULLET} Health dental and vision coverage ` +
			`${LIST_BULLET} Relocation assistance ` +
			'JOB OFFER and SALARY NEGOTIATION QUIZ TRUE FALSE 1. A job offer will always be in writing.';
		const out = stripExercise(text);
		expect(out).toContain('Base salary and pay schedule');
		expect(out).toContain('Health dental and vision coverage');
		expect(out).not.toContain('TRUE FALSE');
		expect(text).toContain(out);
		// The run directly adjacent to the heading is still lost - normalisation leaves no separator
		// between the last list item and the heading, so the damage is bounded rather than eliminated.
		expect(out).not.toContain('Relocation assistance');
	});
});
