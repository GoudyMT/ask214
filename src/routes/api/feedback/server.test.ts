import { describe, it, expect, vi, afterEach } from 'vitest';
import { POST } from './+server';

type Event = Parameters<typeof POST>[0];

function makeEvent(
	body: unknown,
	opts: { ip?: string; limited?: boolean; noKey?: boolean } = {}
): Event {
	return {
		request: { json: async () => body },
		getClientAddress: () => opts.ip ?? '1.2.3.4',
		platform: {
			env: {
				RESEND_API_KEY: opts.noKey ? undefined : 're_test',
				FEEDBACK_TO: 'inbox@example.com',
				FEEDBACK_FROM: 'Test <feedback@send.example.com>',
				FEEDBACK_LIMITER: { limit: async () => ({ success: !opts.limited }) }
			}
		}
	} as unknown as Event;
}

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/feedback', () => {
	it('sends via Resend and returns ok for a valid submission', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"x"}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const res = await POST(makeEvent({ message: 'the ask page broke', route: '/timeline' }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.resend.com/emails');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
		const sent = JSON.parse(init.body as string);
		expect(sent.to).toBe('inbox@example.com');
		expect(sent.from).toBe('Test <feedback@send.example.com>');
		expect(sent.subject).toBe('Ask 214 feedback');
		expect(sent.text).toContain('the ask page broke');
		expect(sent.text).toContain('Page: Timeline');
	});

	it('passes the reply-to when the user gave an email', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		await POST(makeEvent({ message: 'hi', replyEmail: 'a@b.co' }));
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string).reply_to).toBe('a@b.co');
	});

	it('rejects an empty message with 400 and does not send', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const res = await POST(makeEvent({ message: '   ' }));
		expect(res.status).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns 429 when the rate limiter blocks, without sending', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const res = await POST(makeEvent({ message: 'hi' }, { limited: true }));
		expect(res.status).toBe(429);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns 500 when the API key is missing', async () => {
		const res = await POST(makeEvent({ message: 'hi' }, { noKey: true }));
		expect(res.status).toBe(500);
	});
});
