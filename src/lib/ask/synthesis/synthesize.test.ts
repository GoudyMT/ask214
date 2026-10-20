import { describe, it, expect, vi } from 'vitest';
import { synthesize, type RetrievedChunk, type SynthesizeDeps } from './synthesize';
import type { FetchLike } from '../online/retrieve-online';
import { realChunks, collisionId } from './fixtures';

const CHUNKS: RetrievedChunk[] = [
	{
		id: 'tap_moc_crosswalk',
		text: 'SkillBridge lets you train with an employer before separation.',
		sourceId: 'dod_skillbridge',
		url: 'https://example.gov/skillbridge',
		title: 'SkillBridge'
	}
];

// Mirror the online-retrieve stub: a plain object cast to Response, no global constructor.
function stubFetch(
	text: string,
	init: {
		ok?: boolean;
		status?: number;
		throws?: boolean;
		badJson?: boolean;
		stopReason?: string;
	} = {}
) {
	return vi.fn<FetchLike>(async (): Promise<Response> => {
		if (init.throws) throw new Error('network down');
		return {
			ok: init.ok ?? true,
			status: init.status ?? 200,
			json: async () => {
				if (init.badJson) throw new Error('bad json');
				return {
					content: [{ type: 'text', text }],
					stop_reason: init.stopReason ?? 'end_turn'
				};
			}
		} as Response;
	});
}

function deps(fetchImpl: FetchLike): SynthesizeDeps {
	return { fetch: fetchImpl, apiKey: 'test-key' };
}

// Every id in the shipped corpus is `<sourceId>:<12 hex>`, and 8 carry a `-N` collision suffix. The
// fixtures above all use a colon-free id, so nothing exercised a REAL one - and the citation parser's
// character class excluded the colon, so in production every synthesis refused with `no_citations`.
//
// The ids are DERIVED by the shipped identity rule, never written down: a hard-coded literal goes
// stale the moment the corpus is re-cleaned, which is the same fixture-drift that hid the original
// defect.
const REAL_ID_CHUNKS = await realChunks();
const SKILLBRIDGE_ID = REAL_ID_CHUNKS[0]!.id;

describe('synthesize', () => {
	// A TAP guide's chunk url is the shared library DIRECTORY page. A Citation is by contract the one
	// CLICKABLE thing on this surface (model-written links are forced inert), so it has to resolve to the
	// guide itself at the cited page - otherwise the only link the reader is allowed to trust drops them on
	// a list of 21 documents.
	it('resolves a TAP guide citation to the document itself at the cited page', async () => {
		const tapChunks: RetrievedChunk[] = [
			{
				id: 'tap_vet_centers:0fb72e844a79',
				text: 'Vet Centers offer readjustment counseling to combat veterans.',
				sourceId: 'tap_vet_centers',
				page: 2,
				url: 'https://www.tapevents.mil/resources/documents',
				title: 'TAP - Vet Centers'
			}
		];
		const impl = stubFetch(
			'Vet Centers offer readjustment counseling [tap_vet_centers:0fb72e844a79].'
		);
		const result = await synthesize('What is a Vet Center?', tapChunks, deps(impl));
		expect(result.kind).toBe('answer');
		if (result.kind === 'answer') {
			expect(result.answer.citations[0]!.url).toBe(
				'https://www.tapevents.mil/Assets/ResourceContent/TAP/MLC-VETCEN.pdf#page=2'
			);
		}
	});
	// Three passages from one guide used to list the guide's title three times under the summary.
	it('lists each cited document once, opening the page cited first', async () => {
		const guide = (id: string, page: number): RetrievedChunk => ({
			id: `tap_vet_centers:${id}`,
			text: 'Vet Centers offer readjustment counseling to combat veterans and their families.',
			sourceId: 'tap_vet_centers',
			page,
			url: 'https://www.tapevents.mil/resources/documents',
			title: 'TAP - Vet Centers'
		});
		const chunks = [guide('0fb72e844a79', 2), CHUNKS[0]!, guide('1ab72e844a70', 5)];
		const impl = stubFetch(
			'Vet Centers offer counseling [tap_vet_centers:1ab72e844a70] to veterans ' +
				'[tap_vet_centers:0fb72e844a79], and SkillBridge lets you train [tap_moc_crosswalk].'
		);
		const result = await synthesize('What is a Vet Center?', chunks, deps(impl));
		expect(result.kind).toBe('answer');
		if (result.kind === 'answer') {
			expect(result.answer.citations.map((c) => [c.title, c.url])).toEqual([
				[
					'TAP - Vet Centers',
					'https://www.tapevents.mil/Assets/ResourceContent/TAP/MLC-VETCEN.pdf#page=5'
				],
				['SkillBridge', 'https://example.gov/skillbridge']
			]);
		}
	});

	// The documents keep the order search ranked them in, not the order the model happened to cite them.
	it('lists the cited documents in search order', async () => {
		const guide: RetrievedChunk = {
			id: 'tap_vet_centers:0fb72e844a79',
			text: 'Vet Centers offer readjustment counseling to combat veterans and their families.',
			sourceId: 'tap_vet_centers',
			page: 2,
			url: 'https://www.tapevents.mil/resources/documents',
			title: 'TAP - Vet Centers'
		};
		const impl = stubFetch(
			'SkillBridge lets you train [tap_moc_crosswalk], and Vet Centers offer counseling ' +
				'[tap_vet_centers:0fb72e844a79].'
		);
		const result = await synthesize('What is a Vet Center?', [guide, CHUNKS[0]!], deps(impl));
		expect(result.kind).toBe('answer');
		if (result.kind === 'answer') {
			expect(result.answer.citations.map((c) => c.title)).toEqual([
				'TAP - Vet Centers',
				'SkillBridge'
			]);
		}
	});

	it('short-circuits a personalized-eligibility query with no provider call', async () => {
		const impl = stubFetch('unused');
		const result = await synthesize('Do I qualify for the housing grant?', CHUNKS, deps(impl));
		expect(result.kind).toBe('eligibility');
		expect(impl).not.toHaveBeenCalled();
	});

	it('returns a cited answer on the happy path and sends a PII-free browser-direct body', async () => {
		const impl = stubFetch(
			'SkillBridge lets you train with an employer before separation [tap_moc_crosswalk].'
		);
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result.kind).toBe('answer');
		if (result.kind === 'answer') {
			expect(result.answer.citations).toEqual([
				{
					id: 'tap_moc_crosswalk',
					url: 'https://example.gov/skillbridge',
					title: 'SkillBridge'
				}
			]);
			expect(result.answer.disclaimer).toBeTruthy();
		}
		expect(impl).toHaveBeenCalledTimes(1);
		const [url, options] = impl.mock.calls[0]!;
		expect(url).toBe('https://api.anthropic.com/v1/messages');
		expect(options.credentials).toBe('omit');
		const headers = options.headers as Record<string, string>;
		expect(headers['x-api-key']).toBe('test-key');
		expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
		const body = JSON.parse(options.body as string);
		expect(Object.keys(body).sort()).toEqual([
			'max_tokens',
			'messages',
			'model',
			'system',
			'thinking'
		]);
		expect(body).not.toHaveProperty('metadata');
	});

	it('accepts a citation to a real corpus id (sourceId:hash)', async () => {
		const impl = stubFetch(
			`SkillBridge lets you train with a civilian employer during your last 180 days of service [${SKILLBRIDGE_ID}].`
		);
		const result = await synthesize('What is SkillBridge?', REAL_ID_CHUNKS, deps(impl));
		expect(result.kind).toBe('answer');
		if (result.kind === 'answer') {
			expect(result.answer.citations.map((c) => c.id)).toContain(SKILLBRIDGE_ID);
		}
	});

	// The rendered answer must not show the reader 12 characters of hash. Attribution is carried by the
	// verified `citations` list, not by machine syntax left in the prose. Nothing pinned this, which is
	// why "...service [dod_skillbridge:71686373cd68]." would have shipped the moment citations parsed.
	it('renders prose with the citation markers removed', async () => {
		const impl = stubFetch(
			`SkillBridge lets you train with a civilian employer during your last 180 days of service [${SKILLBRIDGE_ID}]. Participation requires unit commander approval [${SKILLBRIDGE_ID}].`
		);
		const result = await synthesize('What is SkillBridge?', REAL_ID_CHUNKS, deps(impl));
		expect(result.kind).toBe('answer');
		if (result.kind === 'answer') {
			expect(result.answer.text).not.toContain('[');
			expect(result.answer.text).not.toContain(SKILLBRIDGE_ID);
			expect(result.answer.text).toContain('last 180 days of service.');
			// Attribution survives in the verified citation list.
			expect(result.answer.citations.map((c) => c.id)).toEqual([SKILLBRIDGE_ID]);
		}
	});

	// The corpus prints "Transfer of Entitlement [TOE]". A bracket of capital letters is kept as an acronym only
	// when a retrieved chunk prints that exact bracket; the answer is then shown with it, not refused.
	const TOE_CHUNKS: RetrievedChunk[] = [
		{
			...REAL_ID_CHUNKS[0]!,
			text: `${REAL_ID_CHUNKS[0]!.text} Members need a Transfer of Entitlement [TOE] on file.`
		}
	];
	it('shows an answer that quotes a bracketed acronym a retrieved chunk prints', async () => {
		const impl = stubFetch(
			`SkillBridge is open to members whose Transfer of Entitlement [TOE] is on file [${SKILLBRIDGE_ID}].`
		);
		const result = await synthesize('What is SkillBridge?', TOE_CHUNKS, deps(impl));
		expect(result.kind).toBe('answer');
		if (result.kind === 'answer') {
			expect(result.answer.text).toContain('Transfer of Entitlement [TOE] is on file.');
			expect(result.answer.citations.map((c) => c.id)).toEqual([SKILLBRIDGE_ID]);
		}
	});

	// A source name written in capitals is not an acronym any source prints: it is a made-up citation, and it
	// must not reach the reader beside a real one. The printed [TOE] does not vouch for another bracket, nor
	// for the same letters in lower case.
	it.each([
		['an acronym no chunk prints', `[${SKILLBRIDGE_ID}] [DOD].`],
		['a source name in capitals', `[${SKILLBRIDGE_ID}] [VABENEFITSGUIDE].`],
		['a printed acronym beside one that is not printed', `[TOE] [${SKILLBRIDGE_ID}] [DOD].`],
		['a printed acronym in lower case', `[${SKILLBRIDGE_ID}] [toe].`]
	])('refuses %s written next to a real citation', async (_name, markers) => {
		const impl = stubFetch(`SkillBridge lets you train with a civilian employer ${markers}`);
		const result = await synthesize('What is SkillBridge?', TOE_CHUNKS, deps(impl));
		expect(result.kind).toBe('refusal');
		if (result.kind === 'refusal') expect(result.reason).toBe('invalid_citation');
	});

	// Any other marker the model writes parses and must be a retrieved id, whatever its case - a made-up source
	// beside a real citation must never reach the reader.
	it.each([
		['an upper-cased id', `[${SKILLBRIDGE_ID}] [DOD_SKILLBRIDGE:ABCDEFABCDEF].`],
		['a bare upper-case source name', `[${SKILLBRIDGE_ID}] [VA_BENEFITS_GUIDE].`],
		['a mixed-case id', `[${SKILLBRIDGE_ID}] [Va_guide:abcdefabcdef].`]
	])('refuses %s written next to a real citation', async (_name, markers) => {
		const impl = stubFetch(`SkillBridge lets you train with a civilian employer ${markers}`);
		const result = await synthesize('What is SkillBridge?', REAL_ID_CHUNKS, deps(impl));
		expect(result.kind).toBe('refusal');
		if (result.kind === 'refusal') expect(result.reason).toBe('invalid_citation');
	});

	it('accepts a citation to a real corpus id carrying a collision suffix', async () => {
		const suffixed = await collisionId('tap_dol_efct', REAL_ID_CHUNKS[1]!.text, 1);
		const chunks = [{ ...REAL_ID_CHUNKS[1]!, id: suffixed }];
		const impl = stubFetch(`The workshop runs for 1 day [${suffixed}].`);
		const result = await synthesize('How long is EFCT?', chunks, deps(impl));
		expect(result.kind).toBe('answer');
	});

	// Markers are REMOVED before grounding, not replaced with a space. Replacing with a space lets a
	// fabricated figure be spliced across valid markers and tokenized into grounded fragments -
	// "2[id]0[id]2[id]5" becomes "2 0 2 5", four single digits almost any source contains. Removing the
	// marker reassembles 2025, which is then checked like any other figure.
	it('refuses a figure spliced across valid citation markers', async () => {
		const impl = stubFetch(
			`Rates change in 2[${SKILLBRIDGE_ID}]0[${SKILLBRIDGE_ID}]2[${SKILLBRIDGE_ID}]5 for all claimants.`
		);
		const result = await synthesize('When do rates change?', REAL_ID_CHUNKS, deps(impl));
		expect(result.kind).toBe('refusal');
		if (result.kind === 'refusal') expect(result.reason).toBe('ungrounded_number');
	});

	// Citation markers are stripped before numeric grounding, so a figure hidden inside brackets would
	// escape the grounding check. It cannot: anything shaped like a citation is ALSO validated against the
	// retrieved set first, and a bare number is not a retrieved id, so the answer refuses either way.
	it('refuses a numeric claim hidden inside citation brackets', async () => {
		const impl = stubFetch(`The monthly rate is [9000] per month [${SKILLBRIDGE_ID}].`);
		const result = await synthesize('What is the rate?', REAL_ID_CHUNKS, deps(impl));
		expect(result.kind).toBe('refusal');
		if (result.kind === 'refusal') expect(result.reason).toBe('invalid_citation');
	});

	// The prompt's SAFETY FIRST clause tells the model to answer a crisis turn with the crisis line and no
	// benefits information - so it cites nothing, and 988 / 838255 appear in no cited chunk. Both gates
	// therefore destroyed it: the user read "we couldn't produce a reliable summary" instead of 988, while
	// crisis/detect.ts documented this clause as the backstop for the indirect phrasing its keyword net
	// deliberately misses.
	it('routes a crisis answer to the crisis surface instead of refusing it', async () => {
		const impl = stubFetch(
			'I am really sorry you are carrying this. You can reach the Veterans Crisis Line right now - dial 988 then press 1, or text 838255.'
		);
		const result = await synthesize('i dont see a way forward anymore', REAL_ID_CHUNKS, deps(impl));
		expect(result.kind).toBe('crisis');
	});

	// The classification sits ahead of ALL THREE gates, keyed on VALID citations rather than parsed ones.
	// The citation pattern accepts digits, so a crisis reply saying "call [988]" - or writing any markdown
	// link - parses as a citation, fails validation, and used to refuse as invalid_citation. The user then
	// read benefits content in answer to a self-harm message.
	it('routes a crisis answer that contains a bracketed token, not just an uncited one', async () => {
		const impl = stubFetch(
			'Please reach out right now. Call [988] and press 1, or text 838255 - the Veterans Crisis Line is staffed day and night.'
		);
		const result = await synthesize('i cant take this anymore', REAL_ID_CHUNKS, deps(impl));
		expect(result.kind).toBe('crisis');
	});

	it('routes a crisis answer that writes a markdown link', async () => {
		const impl = stubFetch(
			'You are not alone. Reach the Veterans Crisis Line at [988](tel:988) and press 1, or text 838255.'
		);
		const result = await synthesize('there is no point to any of this', REAL_ID_CHUNKS, deps(impl));
		expect(result.kind).toBe('crisis');
	});

	// 28 of the 1992 shipped chunks legitimately mention the crisis line, so keying on the number alone
	// would replace a real answer about mental-health resources with a crisis card. Both signals are
	// required: the answer must reach for the crisis line AND cite nothing VALID.
	it('does not treat a cited answer that mentions the crisis line as a crisis turn', async () => {
		const impl = stubFetch(
			`Support is available and the Veterans Crisis Line can be reached at 988 [${SKILLBRIDGE_ID}].`
		);
		const result = await synthesize(
			'what mental health resources exist?',
			REAL_ID_CHUNKS,
			deps(impl)
		);
		expect(result.kind).not.toBe('crisis');
	});

	// Rule 3 orders the model to point at va.gov or 1-800-827-1000 when the sources do not cover the
	// question. That answer cites nothing and names a number no chunk contains, so it was silently
	// discarded as `no_citations`.
	it('routes an uncited official-fallback answer to the not-covered surface', async () => {
		const impl = stubFetch(
			'These sources do not cover state income tax. Try va.gov or call 1-800-827-1000.'
		);
		// A query with no first-person marker, so the eligibility pre-gate (which fires ahead of this and
		// needs a personal fact plus an entitlement ask) cannot claim it first.
		const result = await synthesize(
			'what is the state income tax deadline',
			REAL_ID_CHUNKS,
			deps(impl)
		);
		expect(result.kind).toBe('notCovered');
	});

	// A cut-off reply is never shown, whatever shape is left of it: the cut can fall before the part that mattered.
	it('reports a cut-off official-fallback reply as cut short', async () => {
		const impl = stubFetch('These sources do not cover state income tax. Try va.gov or', {
			stopReason: 'max_tokens'
		});
		const result = await synthesize(
			'what is the state income tax deadline',
			REAL_ID_CHUNKS,
			deps(impl)
		);
		expect(result).toEqual({ kind: 'cutShort' });
	});

	// The gate stays strict for everything else: an uncited answer that reaches for neither authorized
	// contact is still the ungrounded output the gates exist to stop.
	it('still refuses an uncited answer that is neither authorized shape', async () => {
		const impl = stubFetch('SkillBridge is a transition program you should look into.');
		const result = await synthesize('What is SkillBridge?', REAL_ID_CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'refusal', reason: 'no_citations' });
	});

	it('refuses when the model cites an id that was not retrieved', async () => {
		const impl = stubFetch('Here is an answer [not_a_real_id].');
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'refusal', reason: 'invalid_citation' });
	});

	it('refuses when a number in the answer is not grounded in the cited chunk', async () => {
		const impl = stubFetch('You receive $9,999 monthly [tap_moc_crosswalk].');
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'refusal', reason: 'ungrounded_number' });
	});

	it('refuses a non-refusal answer that cites nothing', async () => {
		const impl = stubFetch('SkillBridge is a transition program.');
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'refusal', reason: 'no_citations' });
	});

	it('reports a failed service when the provider request throws', async () => {
		const impl = stubFetch('', { throws: true });
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'serviceFailed' });
	});

	// A key the provider refuses is the one failure the reader can fix, so it is told apart from the rest.
	it.each([401, 403])('reports a rejected key on a %i response', async (status) => {
		const impl = stubFetch('', { ok: false, status });
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'keyRejected' });
	});

	it.each([400, 402, 404, 429, 500, 529])(
		'reports a failed service on a %i response',
		async (status) => {
			const impl = stubFetch('', { ok: false, status });
			const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
			expect(result).toEqual({ kind: 'serviceFailed' });
		}
	);

	it('reports a failed service on a malformed provider body', async () => {
		const impl = stubFetch('', { badJson: true });
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'serviceFailed' });
	});

	// An answer cut off at the token limit can lose its last sentence, caveat included, and every gate would
	// still pass on what is left.
	it('reports a cut-off answer instead of showing it as complete', async () => {
		const impl = stubFetch('SkillBridge lets you train with an employer [tap_moc_crosswalk], and', {
			stopReason: 'max_tokens'
		});
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'cutShort' });
	});

	it('reports a failed service when the provider declines the request', async () => {
		const impl = stubFetch('SkillBridge lets you train [tap_moc_crosswalk].', {
			stopReason: 'refusal'
		});
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'serviceFailed' });
	});

	// The model-side crisis check is the backstop for the indirect phrasing the question's keyword net misses on
	// purpose, so a declined reply that points to the crisis line still shows the crisis card.
	it('still shows the crisis card when the provider declines with the crisis line', async () => {
		const impl = stubFetch(
			'I cannot help with that, but please reach the Veterans Crisis Line: dial 988 then press 1.',
			{ stopReason: 'refusal' }
		);
		const result = await synthesize('i dont see a way forward anymore', REAL_ID_CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'crisis' });
	});

	it('reports a failed service when the provider declines with no text', async () => {
		const impl = stubFetch('', { stopReason: 'refusal' });
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'serviceFailed' });
	});

	// The crisis card is the safe direction: a cut-off reply naming the crisis line still shows it.
	it('still shows the crisis card when a crisis reply is cut off', async () => {
		const impl = stubFetch('Please call the Veterans Crisis Line: dial 988 then press 1, or', {
			stopReason: 'max_tokens'
		});
		const result = await synthesize('I feel hopeless', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'crisis' });
	});

	it('aborts and reports a failed service when the provider request exceeds the timeout', async () => {
		// A connection that accepts but never settles, rejecting only when the caller aborts.
		const hanging = vi.fn<FetchLike>(
			(_url, options) =>
				new Promise<Response>((_resolve, reject) => {
					options.signal?.addEventListener('abort', () =>
						reject(new DOMException('aborted', 'AbortError'))
					);
				})
		);
		const result = await synthesize('What is SkillBridge?', CHUNKS, {
			fetch: hanging,
			apiKey: 'test-key',
			timeoutMs: 10
		});
		expect(result).toEqual({ kind: 'serviceFailed' });
	});

	it('feeds the model display-cleaned source text, not the raw extraction artifacts', async () => {
		// A chunk carrying an inline bullet glyph and a fused publication footer - the exact display
		// artifacts cleanExcerpt strips. The model must read the cleaned text, never the raw glyph/footer.
		// Source stays ASCII: the glyph is built from its code point (mirrors clean-excerpt.test.ts).
		const bullet = String.fromCodePoint(0x2022); // bullet dot
		const dirty: RetrievedChunk[] = [
			{
				id: 'tap_moc_crosswalk',
				text: `SkillBridge ${bullet} train with an employer before separation. Version 6.1 Released May 2025`,
				sourceId: 'dod_skillbridge',
				url: 'https://example.gov/skillbridge',
				title: 'SkillBridge'
			}
		];
		const impl = stubFetch(
			'SkillBridge lets you train with an employer before separation [tap_moc_crosswalk].'
		);
		await synthesize('What is SkillBridge?', dirty, deps(impl));
		const [, options] = impl.mock.calls[0]!;
		const system = JSON.parse(options.body as string).system as string;
		expect(system).toContain('SkillBridge - train with an employer before separation.');
		expect(system).not.toContain(bullet);
		expect(system).not.toContain('Version 6.1');
	});

	it('grounds numbers against the cleaned cited text, not a stripped footer figure', async () => {
		// The only "2025" lives in the fused footer cleanExcerpt removes. A model figure of 2025 is
		// ungrounded - the model never saw it as content, so the raw footer must not vouch for it.
		const dirty: RetrievedChunk[] = [
			{
				id: 'tap_moc_crosswalk',
				text: 'SkillBridge lets you train with an employer. Version 6.1 Released May 2025',
				sourceId: 'dod_skillbridge',
				url: 'https://example.gov/skillbridge',
				title: 'SkillBridge'
			}
		];
		const impl = stubFetch('SkillBridge started in 2025 [tap_moc_crosswalk].');
		const result = await synthesize('What is SkillBridge?', dirty, deps(impl));
		expect(result).toEqual({ kind: 'refusal', reason: 'ungrounded_number' });
	});

	it('preserves a real benefit figure through cleaning so a grounded answer is not falsely refused', async () => {
		// The fused footer is stripped, but the real dollar figure in the prose survives cleaning and still
		// grounds the model's cited answer. Cleaning must never turn a legitimate figure into a false refusal.
		const dirty: RetrievedChunk[] = [
			{
				id: 'tap_moc_crosswalk',
				text: 'The relocation allowance is $3,000 for eligible members. Version 6.1 Released May 2025',
				sourceId: 'dod_skillbridge',
				url: 'https://example.gov/skillbridge',
				title: 'SkillBridge'
			}
		];
		const impl = stubFetch('The relocation allowance is $3,000 [tap_moc_crosswalk].');
		const result = await synthesize('What is the relocation allowance?', dirty, deps(impl));
		expect(result.kind).toBe('answer');
	});
});
