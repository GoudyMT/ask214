import { splitSentences } from '$lib/content-ops/chunk/sentences';

// Measured against this project's own benchmark, END TO END through real retrieval (`pnpm answer-gate`):
// the answer lands inside the selected text for 28.9% of the 135 answerable queries, against 25.9% for the
// 120-word result card this replaces, at a median of 52 words and a hard maximum of 67.
//
// Read that 28.9% honestly. An earlier version of the gate paired each query to the chunk that CONTAINS
// its answer and reported 86.7%; that is selection quality given perfect retrieval, not the feature's
// score, and quoting it here was wrong. The ceiling is what retrieval can reach - the answer is in SOME
// retrieved card 59.3% of the time - so the remaining gap is a retrieval problem, not a selection one.
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
function subdivideLists(sentences: string[], limit: number): string[] {
	const out: string[] = [];
	for (const sentence of sentences) {
		if (wordCount(sentence) <= limit || !sentence.includes(' - ')) {
			out.push(sentence);
			continue;
		}
		let buffer = '';
		for (const part of sentence.split(' - ')) {
			const merged = buffer === '' ? part : `${buffer} - ${part}`;
			if (buffer !== '' && wordCount(merged) > limit) {
				out.push(buffer);
				buffer = part;
			} else {
				buffer = merged;
			}
		}
		if (buffer !== '') out.push(buffer);
	}
	return out;
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
function packRun(sentences: string[], from: number, limit: number): string[] {
	const run: string[] = [];
	let count = 0;
	for (let i = from; i < sentences.length; i++) {
		const sentence = sentences[i]!;
		const n = wordCount(sentence);
		if (run.length > 0 && count + n > limit) break;
		if (run.length === 0 && n > limit) {
			// An unmarked cut reads as the document's complete statement - the same rule the result card
			// states and enforces with its own ellipsis.
			return [
				sentence
					.split(/\s+/)
					.slice(0, limit)
					.join(' ')
					.replace(/(?: -)+$/, '') + '...'
			];
		}
		run.push(sentence);
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
	const sentences = subdivideLists(
		splitSentences(body)
			.map(({ start, end }) => body.slice(start, end).trim())
			.filter((s) => s.length > 0),
		ceiling
	);
	if (sentences.length === 0) return '';

	const terms = contentTerms(query);
	let from = 0;
	if (terms.size > 0) {
		let bestScore = -1;
		for (let i = 0; i < sentences.length; i++) {
			const candidate = normalize(packRun(sentences, i, TARGET_WORDS).join(' '));
			let score = 0;
			for (const term of terms) if (candidate.includes(term)) score++;
			if (score > bestScore) {
				bestScore = score;
				from = i;
			}
		}
	}
	return packRun(sentences, from, ceiling).join(' ');
}
