import { splitSentences } from '$lib/content-ops/chunk/sentences';

// Measured END TO END through real retrieval over the 135 answerable benchmark queries, 2026-09-11.
// Regenerate with `pnpm answer-gate:bge` (online) or `pnpm answer-gate` (device) - these move whenever the
// corpus, the benchmark or the pipeline does, so treat them as a dated reading, not a constant:
//
//                          online   device
//     this selected text    50.4%    42.2%
//     the 120-word card     51.1%    39.3%
//     after tapping More    62.2%    50.4%
//
// The constants below cap the output at 67 words.
//
// Two things this selector is NOT. It is not why the score sits near half: the answer is in SOME retrieved
// card 85.2% of the time online, and choosing the best of those by hand reaches 74.1%, so the loss is in
// card choice and ranking - where four independent methods each moved it by nothing. And the word-picking
// itself is worth roughly zero: against simply taking the first N words of the same passage at the same
// budget it measured 0.0pp on device and +1.5pp online. Its real value is that the output ends on a
// sentence boundary.
//
// Scoring these runs by embedding cosine to the query, instead of by term overlap, has been measured and is
// dead: it won 9 queries and lost 8 for +0.7pp, McNemar p=1.0. (That run predates the benchmark correction
// that produced the table above; the margin was indistinguishable from a coin flip either way.) Cosine
// scores TOPICALITY, so a short on-topic stub ("Learn more about how the Rudisill decision affects you")
// outranks the longer sentence that answers. Term overlap resists that by accident, because an answering
// sentence carries more of the question's specific nouns than a stub does. Do not re-try it.
const TARGET_WORDS = 45;
// A sentence may cross the target up to this multiple. Extraction leaves long lists with no terminator, so
// they read as one huge sentence; without the ceiling the packer stops on the short lead-in immediately
// before the answer.
const CEILING_MULTIPLIER = 1.5;
// Words too common to carry query signal. Deliberately small - enough to stop "what/how/the/my" dominating
// the score, not a real stoplist.
const STOP_WORDS = new Set(
	(
		'what how when where why who which the a an of to for and or in on at is are do does i my me ' +
		'you your can if it that this with be been will would should'
	).split(' ')
);

function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9 ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

function contentTerms(query: string): Set<string> {
	return new Set(
		normalize(query)
			.split(' ')
			.filter((w) => w.length > 2 && !STOP_WORDS.has(w))
	);
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
 * Choose the sentences of `body` that answer `query` - the short answer shown above the result cards.
 *
 * Consecutive sentence runs are scored by how many of the query's content terms they contain; the
 * highest-scoring start wins, earliest on a tie because these documents are written answer-first. Whole
 * sentences only: cutting on a word boundary measured WORSE than doing nothing clever, because it breaks
 * the answer apart. The scoring window packs to the target while the emitted run may reach the ceiling -
 * that asymmetry is what the measurement was taken against.
 *
 * @param body The cleaned chunk text, heading echo already stripped.
 * @param query The user's question.
 * @returns The selected sentences joined by a space, or '' when the body holds no sentences.
 */
export function selectAnswer(body: string, query: string): string {
	const ceiling = TARGET_WORDS * CEILING_MULTIPLIER;
	const units = subdivideLists(
		splitSentences(body)
			.map(({ start, end }) => body.slice(start, end).trim())
			.filter((s) => s.length > 0),
		ceiling
	);
	if (units.length === 0) return '';

	const terms = contentTerms(query);
	let from = 0;
	if (terms.size > 0) {
		let bestScore = -1;
		for (let i = 0; i < units.length; i++) {
			const candidate = normalize(joinUnits(packRun(units, i, TARGET_WORDS)));
			let score = 0;
			for (const term of terms) if (candidate.includes(term)) score++;
			if (score > bestScore) {
				bestScore = score;
				from = i;
			}
		}
	}
	const text = joinUnits(packRun(units, from, ceiling));
	// A LEADING cut, marked the way the trailing one already is. Everything before `from` is text the
	// document has and the reader does not, and in a benefits document that is usually the condition or the
	// negation governing what follows - so an unmarked start can turn "you are NOT eligible if X" into a
	// flat statement that X applies to the reader. Attached with no space, matching the trailing form.
	return from > 0 ? `...${text}` : text;
}
