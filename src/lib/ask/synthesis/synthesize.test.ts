import { describe, it, expect, vi } from 'vitest';
import { synthesize, type RetrievedChunk, type SynthesizeDeps } from './synthesize';
import type { FetchLike } from '../online/retrieve-online';

const CHUNKS: RetrievedChunk[] = [
	{
		id: 'tap_moc_crosswalk',
		text: 'SkillBridge lets you train with an employer before separation.',
		url: 'https://example.gov/skillbridge',
		title: 'SkillBridge'
	}
];

// Mirror the online-retrieve stub: a plain object cast to Response, no global constructor.
function stubFetch(
	text: string,
	init: { ok?: boolean; status?: number; throws?: boolean; badJson?: boolean } = {}
) {
	return vi.fn<FetchLike>(async (): Promise<Response> => {
		if (init.throws) throw new Error('network down');
		return {
			ok: init.ok ?? true,
			status: init.status ?? 200,
			json: async () => {
				if (init.badJson) throw new Error('bad json');
				return { content: [{ type: 'text', text }] };
			}
		} as Response;
	});
}

function deps(fetchImpl: FetchLike): SynthesizeDeps {
	return { fetch: fetchImpl, apiKey: 'test-key' };
}

describe('synthesize', () => {
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
				{ id: 'tap_moc_crosswalk', url: 'https://example.gov/skillbridge', title: 'SkillBridge' }
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

	it('degrades when the provider request throws', async () => {
		const impl = stubFetch('', { throws: true });
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'degraded' });
	});

	it('degrades on a non-ok provider response (bad or expired key)', async () => {
		const impl = stubFetch('', { ok: false, status: 401 });
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'degraded' });
	});

	it('degrades on a malformed provider body', async () => {
		const impl = stubFetch('', { badJson: true });
		const result = await synthesize('What is SkillBridge?', CHUNKS, deps(impl));
		expect(result).toEqual({ kind: 'degraded' });
	});
});
