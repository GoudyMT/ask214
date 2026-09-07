import { splitSentences } from '$lib/content-ops/chunk/sentences';

// Measured against this project's own benchmark: a 45-word target puts the answer inside the selected text
// for 86.7% of the 135 answerable queries, at about a third of the length of the 120-word result card.
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

/** Whole sentences from `from`, to the target, allowing one sentence to cross it up to `limit`. */
function packRun(sentences: string[], from: number, limit: number): string[] {
	const run: string[] = [];
	let count = 0;
	for (let i = from; i < sentences.length; i++) {
		const sentence = sentences[i]!;
		const n = wordCount(sentence);
		if (run.length > 0 && count + n > limit) break;
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
	const sentences = splitSentences(body)
		.map(({ start, end }) => body.slice(start, end).trim())
		.filter((s) => s.length > 0);
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
	return packRun(sentences, from, TARGET_WORDS * CEILING_MULTIPLIER).join(' ');
}
