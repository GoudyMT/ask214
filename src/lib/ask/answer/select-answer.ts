import { splitSentences } from '$lib/content-ops/chunk/sentences';

// The answer surface shown above the result cards. It emits the OPENING sentences of the chosen chunk,
// whole, up to 120 words.
//
// What replaced what, and why, measured 2026-09-13 by blind paired judgement over the 135 benchmark
// queries: this previously emitted a ~52-word run chosen by query-term score. Judged as a reader would,
// that shipped misleading text on 20.7% of queries against 13.3% for the 120-word lead card it replaced -
// and 17 of those were answers the card had got right. The cause is structural, not a tuning error: a run
// starting partway into a passage drops whatever governed it, which on a benefits document is the
// condition, the deadline or the negation.
//
// Regenerate the rates with `pnpm answer-gate:bge` (online) or `pnpm answer-gate` (device). They move
// whenever the corpus, the benchmark or the pipeline does, so treat any number here as a dated reading.
//
// Known and settled, so that none of it is re-litigated: the loss is NOT in this module. The answer is in
// SOME retrieved card 85.2% of the time online while the rendered answer reaches roughly half that, so the
// gap lives in card choice and retrieval, where four independent methods each moved it by nothing.
// 120 words, matching the lead card exactly, because this block now renders that card's own passage. An
// earlier 80-word target emitted a median of 82 words against the card's 118 and so scored BELOW the surface
// it is meant to equal - the block was quietly showing less than the card while claiming to be it.
//
// NARROWING was measured (2026-09-16) and rejected, and not for the reason it was once expected to fail.
// A 52-word budget, judged blind and paired over all 135 benchmark queries with both arms rendered as the
// app draws them, moved HARM by nothing: 5 against 4, McNemar p = 1.0. The old argument that a short window
// severs conditions no longer holds on this corpus. It fails instead because the answer stops being there:
// tier 1 falls from 37.8% to 28.9%, eight points under the enforced regression floor, and the gate rejects
// it. Short is not dangerous here, short is empty.
//
// So do NOT narrow this to manufacture a second tier. Tier 2 is missing on 57% of queries because the
// passage is frequently no longer than the answer, not because this number is too large; narrowing buys 45
// expansions by moving 13 answers out of view, and most of those expansions are the same text one tap
// further away. The lever for tier 2 is more content BEHIND the answer, which is a chunk-size question.
// The failure is monotone in this number, so intermediate budgets interpolate rather than surprise.
const TARGET_WORDS = 120;
// No headroom above the target: the ceiling IS the card's cap. A single sentence longer than that is cut on
// a word boundary and the cut is marked, which is the one place this module cuts mid-sentence.
const CEILING_MULTIPLIER = 1;

function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Break up a "sentence" that is really a flattened list.
 *
 * `cleanExcerpt` turns bullet glyphs into ` - ` separators, and those lists carry no sentence terminator,
 * so `splitSentences` returns them as one unit - routinely 100+ words, measured up to 226. Truncating such
 * a unit from its start always keeps the first few bullets and discards the rest, which is exactly where
 * the answer often is. Subdividing on the separators instead lets the normal run-selection choose WITHIN
 * the list, so the algorithm handles it rather than a special case.
 *
 * Only oversized units are touched; a real sentence containing " - " is left whole.
 */
/**
 * One packable unit: a whole sentence, or one piece of a flattened list that was split for size.
 *
 * `continuesList` records that a list separator stood between this piece and the one before it, so a run
 * spanning both can put it back. Rejoining with a plain space fused two independent bullets into one
 * continuous statement - a "you may use this for X" item welded to a "you may not use it for Y" item reads
 * as a sentence the document never wrote.
 */
type Unit = { text: string; continuesList: boolean };

function subdivideLists(sentences: string[], limit: number): Unit[] {
	const out: Unit[] = [];
	for (const sentence of sentences) {
		if (wordCount(sentence) <= limit || !sentence.includes(' - ')) {
			out.push({ text: sentence, continuesList: false });
			continue;
		}
		let buffer = '';
		// The first piece of a split sentence follows whatever preceded the sentence, not a list separator;
		// every piece after it does.
		let firstPiece = true;
		for (const part of sentence.split(' - ')) {
			const merged = buffer === '' ? part : `${buffer} - ${part}`;
			if (buffer !== '' && wordCount(merged) > limit) {
				out.push({ text: buffer, continuesList: !firstPiece });
				firstPiece = false;
				buffer = part;
			} else {
				buffer = merged;
			}
		}
		if (buffer !== '') out.push({ text: buffer, continuesList: !firstPiece });
	}
	return out;
}

/** Reassemble a run, restoring the separator between pieces that a list split apart. */
function joinUnits(units: Unit[]): string {
	return units.reduce(
		(acc, unit, i) =>
			i === 0 ? unit.text : `${acc}${unit.continuesList ? ' - ' : ' '}${unit.text}`,
		''
	);
}

/**
 * Whole sentences from `from`, to the target, allowing one sentence to cross it up to `limit`.
 *
 * The first sentence is taken even when it alone busts the limit, because a run has to contain something -
 * but it is then CUT, with the cut marked. Without that cut this was not a ceiling at all: 13.3% of answers
 * came out LONGER than the 120-word card this feature replaces, to a measured maximum of 226. A short
 * answer longer than the thing it replaced has inverted its own premise.
 *
 * Cutting mid-sentence is otherwise forbidden here (it measured worse than doing nothing clever), so this
 * is deliberately the single exception, and `subdivideLists` above keeps it rare - it is reached only for
 * an oversized run with no separators to break on.
 */
function packRun(units: Unit[], from: number, limit: number): Unit[] {
	const run: Unit[] = [];
	let count = 0;
	for (let i = from; i < units.length; i++) {
		const unit = units[i]!;
		const n = wordCount(unit.text);
		if (run.length > 0 && count + n > limit) break;
		if (run.length === 0 && n > limit) {
			// An unmarked cut reads as the document's complete statement - the same rule the result card
			// states and enforces with its own ellipsis.
			return [
				{
					text:
						unit.text
							.split(/\s+/)
							.slice(0, limit)
							.join(' ')
							.replace(/(?: -)+$/, '') + '...',
					continuesList: unit.continuesList
				}
			];
		}
		run.push(unit);
		count += n;
		if (count >= TARGET_WORDS) break;
	}
	return run;
}

/**
 * Whole sentences from the opening of `body`, up to the ceiling - the answer shown above the result cards.
 *
 * It begins at the opening rather than at a query-scored run, and that is the whole point. Scoring a start
 * position measured 0.0pp on device and +1.5pp online against a plain head window of the same length, so it
 * bought nothing - while costing a great deal. A run beginning partway into a passage silently drops
 * whatever governed it, and in a benefits document that is the condition, the deadline, or the negation. The
 * result is text that is true in the source and false on screen, which is the one shape 38 CFR 14.629
 * forbids: quoting verbatim guarantees fidelity to the source's WORDS, not to its TRUTH CONDITIONS.
 *
 * Measured by blind paired judgement over the 135 benchmark queries, 2026-09-13: a start-scored 52-word
 * window shipped misleading text on 20.7% of them against 13.3% for the 120-word head window it replaced,
 * and 17 of those were answers the head window had got right. Hence the opening, and hence the 120-word
 * ceiling that matches the card measured at 13.3%.
 *
 * Do NOT re-introduce start scoring in any form. Term overlap is what this replaced; embedding cosine was
 * measured separately at +0.7pp, 9 queries won and 8 lost, McNemar p=1.0, because cosine scores TOPICALITY
 * and a short on-topic stub outranks the sentence that answers.
 *
 * @param body The cleaned chunk text, heading echo already stripped.
 * @returns The opening sentences joined by a space, or '' when the body holds no sentences.
 */
export function selectAnswer(body: string): string {
	const ceiling = TARGET_WORDS * CEILING_MULTIPLIER;
	const units = subdivideLists(
		splitSentences(body)
			.map(({ start, end }) => body.slice(start, end).trim())
			.filter((s) => s.length > 0),
		ceiling
	);
	if (units.length === 0) return '';
	return joinUnits(packRun(units, 0, ceiling));
}
