import { detectEligibilityIntent } from './eligibility-gate';
import { buildMessages } from './system-prompt';
import { validateCitations } from './citation-validation';
import { checkNumericGrounding } from './grounding';
import { toCitedAnswer, type Citation, type CitedAnswer } from './cited-answer';
import { assertOnlyKeys } from '../online/payload';
import type { FetchLike } from '../online/retrieve-online';

/** A retrieved chunk: the text the model reads plus the fields a rendered citation is built from. */
export interface RetrievedChunk {
	id: string;
	text: string;
	url: string;
	title: string;
}

export interface SynthesizeDeps {
	fetch: FetchLike;
	// The BYO key travels only in the request header, browser-direct to Anthropic; it never reaches our
	// servers and is never placed in the request body.
	apiKey: string;
}

export type SynthesisResult =
	| { kind: 'answer'; answer: CitedAnswer }
	| { kind: 'eligibility' }
	| { kind: 'refusal'; reason: 'invalid_citation' | 'ungrounded_number' | 'no_citations' }
	| { kind: 'degraded' };

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;

// A structural allowlist, not a token blocklist: exactly the keys the Messages API needs, and never
// `metadata` (Anthropic's caller-supplied user-tracking field) or any profile/PII key. A type alias, not
// an interface, so it satisfies the assertOnlyKeys Record signature.
type SynthesisRequestBody = {
	model: string;
	max_tokens: number;
	thinking: { type: 'disabled' };
	system: string;
	messages: { role: 'user'; content: string }[];
};

// Pull the model's answer text out of the Messages response. A shape we cannot read is a degrade, never a
// silent empty answer.
function extractText(json: unknown): string {
	const content = (json as { content?: unknown } | null)?.content;
	if (!Array.isArray(content)) throw new Error('E_SYNTH_BAD_RESPONSE');
	const text = content
		.filter(
			(b): b is { type: 'text'; text: string } =>
				typeof b === 'object' &&
				b !== null &&
				(b as { type?: unknown }).type === 'text' &&
				typeof (b as { text?: unknown }).text === 'string'
		)
		.map((b) => b.text)
		.join('');
	if (text.length === 0) throw new Error('E_SYNTH_BAD_RESPONSE');
	return text;
}

// The prompt requires every factual sentence to cite its source id in brackets, e.g. [tap_moc_crosswalk].
const CITATION = /\[([a-z0-9_.-]+)\]/gi;

function parseCitedIds(text: string): string[] {
	const ids = new Set<string>();
	for (const match of text.matchAll(CITATION)) {
		const id = match[1];
		if (id) ids.add(id);
	}
	return [...ids];
}

/**
 * Run a BYO-key synthesis request through the safety backstops.
 *
 * @param query The user's raw question.
 * @param chunks The retrieved chunks to answer from.
 * @param deps Injected fetch + the BYO key.
 * @returns A cited answer, an eligibility short-circuit, a refusal, or a degrade to raw results.
 */
export async function synthesize(
	query: string,
	chunks: RetrievedChunk[],
	deps: SynthesizeDeps
): Promise<SynthesisResult> {
	// SAFETY: a personalized-eligibility query is answered impersonally and never reaches the model.
	if (detectEligibilityIntent(query).shortCircuit) return { kind: 'eligibility' };

	const { system, messages } = buildMessages(
		query,
		chunks.map((c) => ({ id: c.id, text: c.text }))
	);
	const body: SynthesisRequestBody = {
		model: MODEL,
		max_tokens: MAX_TOKENS,
		thinking: { type: 'disabled' },
		system,
		messages
	};
	assertOnlyKeys(body, ['model', 'max_tokens', 'thinking', 'system', 'messages']);

	let res: Response;
	try {
		res = await deps.fetch(ENDPOINT, {
			method: 'POST',
			credentials: 'omit',
			headers: {
				'content-type': 'application/json',
				'x-api-key': deps.apiKey,
				'anthropic-version': '2023-06-01',
				'anthropic-dangerous-direct-browser-access': 'true'
			},
			body: JSON.stringify(body)
		});
	} catch {
		return { kind: 'degraded' };
	}
	if (!res.ok) return { kind: 'degraded' };

	let modelText: string;
	try {
		modelText = extractText(await res.json());
	} catch {
		return { kind: 'degraded' };
	}

	const citedIds = parseCitedIds(modelText);
	const retrievedIds = new Set(chunks.map((c) => c.id));
	if (!validateCitations(citedIds, retrievedIds).ok) {
		return { kind: 'refusal', reason: 'invalid_citation' };
	}
	// A non-refusal answer that cites nothing is exactly the ungrounded output the gates exist to stop.
	if (citedIds.length === 0) return { kind: 'refusal', reason: 'no_citations' };

	// Ground numbers against the cited chunks only, so a figure in an uncited chunk cannot vouch for one.
	const citedText = chunks
		.filter((c) => citedIds.includes(c.id))
		.map((c) => c.text)
		.join('\n\n');
	if (!checkNumericGrounding(modelText, citedText).grounded) {
		return { kind: 'refusal', reason: 'ungrounded_number' };
	}

	const citations: Citation[] = chunks.map((c) => ({ id: c.id, url: c.url, title: c.title }));
	return { kind: 'answer', answer: toCitedAnswer(modelText, citedIds, citations) };
}
