import { render } from 'vitest-browser-svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import FeedbackPage from './+page.svelte';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Feedback page send', () => {
	// A connection that opens and then says nothing would leave the member on "Sending" for good, with no way to
	// know the message did not go. The send is given up at a bound and shows the failure line with the email
	// address to use instead.
	it('gives up on a send that never answers and shows the failure line', async () => {
		const stop = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(stop.signal);
		const silent = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) =>
					init.signal?.addEventListener('abort', () => reject(new Error('TimeoutError')))
				)
		);
		vi.stubGlobal('fetch', silent);
		const { container } = await render(FeedbackPage);
		// The bound starts with each send: one started at page load would cut every send made after it.
		expect(timeout).not.toHaveBeenCalled();

		const message = container.querySelector('#fb-msg') as HTMLTextAreaElement;
		message.value = 'the timeline page is slow';
		message.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => expect(silent).toHaveBeenCalledOnce());
		stop.abort();

		await vi.waitFor(() => expect(container.textContent).toContain("That didn't send."));
		expect(timeout).toHaveBeenCalledWith(20_000);
		expect(silent.mock.calls[0]?.[1].signal).toBe(stop.signal);
	});

	// The app is finished and runs with no one on duty: neither the page nor the sent panel may promise a reply,
	// or a member who left an email waits for one that never comes.
	it('never promises a reply, before or after a send', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 200 }))
		);
		const { container } = await render(FeedbackPage);
		// innerText reads the page as drawn: the source's line breaks inside a paragraph collapse to spaces.
		expect(container.innerText).toContain("can't promise a reply");
		expect(container.innerText).not.toMatch(/get back to you|read every message/i);

		const message = container.querySelector('#fb-msg') as HTMLTextAreaElement;
		message.value = 'the timeline page is slow';
		message.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		(container.querySelector('form') as HTMLFormElement).requestSubmit();

		await vi.waitFor(() => expect(container.textContent).toContain('your feedback was sent'));
		// pin: 4 - copy the owner locked on 2026-11-14.
		expect(container.innerText).toContain(
			"I read messages when I can, but I can't promise a reply."
		);
		expect(container.innerText).not.toMatch(/get back to you|read every message/i);
	});
});
