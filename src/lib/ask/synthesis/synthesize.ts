import { detectEligibilityIntent } from './eligibility-gate';
import { buildMessages } from './system-prompt';
import { validateCitations, parseCitedIds, stripCitations } from './citation-validation';
import { checkNumericGrounding } from './grounding';
import { mentionsCrisisLine, mentionsOfficialFallback } from '../crisis/contacts';
import { toCitedAnswer, type Citation, type CitedAnswer } from './cited-answer';
import { assertOnlyKeys } from '../online/payload';
import { cleanExcerpt } from '$lib/corpus';
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
	// Bound the request so a hung connection degrades to raw cards instead of stranding the spinner.
	// Generous (an LLM completion is slower than retrieval); overridable for tests.
	timeoutMs?: number;
}

export type SynthesisResult =
	| { kind: 'answer'; answer: CitedAnswer }
	| { kind: 'eligibility' }
	// The two authorized out-of-source outcomes. The model classifies; the UI supplies the words.
	| { kind: 'crisis' }
	| { kind: 'notCovered' }
	| { kind: 'refusal'; reason: 'invalid_citation' | 'ungrounded_number' | 'no_citations' }
	| { kind: 'degraded' };

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const SYNTH_TIMEOUT_MS = 30_000;

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

	// Clean the display artifacts (fused publication footers, running headers, control-code garbage, bullet
	// glyphs) out of each chunk ONCE, here at the single chunk-entry point, so the model reads the same text
	// the source cards show AND numeric grounding checks against exactly what the model read.
	//
	// Cleaning DOES remove figures - 407 of the 1878 shipped chunks lose at least one numeric token, most
	// often a publication year carried in the version footer ("2025", in 92 chunks), then page and section
	// numbers. That is deliberate, and the grounding basis is the CLEANED text on purpose: grounding
	// against the raw text would let a footer's publication year vouch for a model claim like "rates
	// increase in 2025", which is exactly the deadline-as-current error rule 7 of the system prompt exists
	// to prevent.
	//
	// The cost is that a number the model echoes from the USER'S QUESTION ("what does Module 2 cover?")
	// is refused as ungrounded when cleaning removed it from the source. That is the safe direction: the
	// model never saw the removed figure, so it did not read it from the source, and a number the user
	// supplied must not be able to vouch for itself.
	const cleanedChunks = chunks.map((c) => ({ ...c, text: cleanExcerpt(c.text) }));

	const { system, messages } = buildMessages(
		query,
		cleanedChunks.map((c) => ({ id: c.id, text: c.text }))
	);
	const body: SynthesisRequestBody = {
		model: MODEL,
		max_tokens: MAX_TOKENS,
		thinking: { type: 'disabled' },
		system,
		messages
	};
	assertOnlyKeys(body, ['model', 'max_tokens', 'thinking', 'system', 'messages']);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? SYNTH_TIMEOUT_MS);
	let modelText: string;
	try {
		const res = await deps.fetch(ENDPOINT, {
			method: 'POST',
			credentials: 'omit',
			headers: {
				'content-type': 'application/json',
				'x-api-key': deps.apiKey,
				'anthropic-version': '2023-06-01',
				'anthropic-dangerous-direct-browser-access': 'true'
			},
			body: JSON.stringify(body),
			signal: controller.signal
		});
		if (!res.ok) return { kind: 'degraded' };
		modelText = extractText(await res.json());
	} catch {
		// throw / abort (timeout) / unreadable body -> degrade to raw cards
		return { kind: 'degraded' };
	} finally {
		clearTimeout(timer);
	}

	// The prompt authorizes exactly TWO answers that legitimately carry information not in the sources:
	// the crisis line, and the "sources do not cover this" fallback. Both cite nothing by design, and both
	// name a phone number no chunk contains - so both were being destroyed by the two gates below. A crisis
	// reply reached `no_citations` and the user read "we couldn't produce a reliable summary" instead of
	// 988, while `crisis/detect.ts` documented this prompt clause as the backstop for the indirect phrasing
	// its keyword net deliberately misses.
	//
	// They are classified out HERE, ahead of the gates, and the model's own wording is discarded. What the
	// user sees is the shipped CrisisCard or our own no-coverage copy - the model decides WHICH surface,
	// never what it says. That keeps both gates absolutely strict: no model prose is ever exempted from
	// them, because prose that would need an exemption is not rendered at all.
	// BOTH authorized shapes cite nothing - the prompt tells the model to give no benefits information on a
	// crisis turn, and there is nothing to cite when the sources do not cover the question. Requiring the
	// answer to be UNCITED is what keeps the classification precise: 29 of the 1878 shipped chunks
	// legitimately mention the crisis line, so keying on the number alone would replace a real, useful
	// answer about mental-health resources with a crisis card.
	const citedIds = parseCitedIds(modelText);
	const retrievedIds = new Set(chunks.map((c) => c.id));
	if (!validateCitations(citedIds, retrievedIds).ok) {
		return { kind: 'refusal', reason: 'invalid_citation' };
	}
	if (citedIds.length === 0) {
		if (mentionsCrisisLine(modelText)) return { kind: 'crisis' };
		if (mentionsOfficialFallback(modelText)) return { kind: 'notCovered' };
		// Citing nothing otherwise is exactly the ungrounded output the gates exist to stop.
		return { kind: 'refusal', reason: 'no_citations' };
	}

	// Ground numbers against the cited chunks only, so a figure in an uncited chunk cannot vouch for one.
	// This is the SAME cleaned text the model read above, so the grounding basis stays consistent with the input.
	const citedText = cleanedChunks
		.filter((c) => citedIds.includes(c.id))
		.map((c) => c.text)
		.join('\n\n');
	// Ground the PROSE the reader ends up with, not the citation markers - a chunk id ends in 12 hex
	// characters, so the marker itself carries digits that are metadata, not claims the source must
	// support. `stripCitations` is the SAME transform the rendered answer uses, so the gate can never
	// check text the reader does not see. See its contract for why removal, not substitution.
	const prose = stripCitations(modelText);
	if (!checkNumericGrounding(prose, citedText).grounded) {
		return { kind: 'refusal', reason: 'ungrounded_number' };
	}

	const citations: Citation[] = chunks.map((c) => ({ id: c.id, url: c.url, title: c.title }));
	return { kind: 'answer', answer: toCitedAnswer(modelText, citedIds, citations) };
}
