import { describe, it, expect, vi } from 'vitest';
import { createHttp } from './pull.ts';

// The real wiring is the last line of defence for the server we do not run: it must name us, must never follow a
// redirect to somewhere else, must never be pointed off the one host, and must not let a hostile or broken reply
// fill memory. No test here opens a socket: fetch is a fake.

const LOOKUP = 'https://api.skillbridge.mil/Location/Lookup?draw=1&start=0&length=150';
const MIB = 1024 * 1024;

function chunkedBody(
	chunks: number,
	chunkBytes: number
): { body: ReadableStream<Uint8Array>; pulls: () => number } {
	let pulled = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pulled >= chunks) {
				controller.close();
				return;
			}
			pulled++;
			controller.enqueue(new Uint8Array(chunkBytes).fill(97));
		}
	});
	return { body, pulls: () => pulled };
}

describe('createHttp', () => {
	it('names the project, never follows a redirect, sets a timeout, and returns status, type and text', async () => {
		const fetchFake = vi.fn<typeof fetch>(() =>
			Promise.resolve(
				new Response('{"ok":true}', {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);
		const reply = await createHttp(fetchFake)(LOOKUP);
		expect(reply).toEqual({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
		expect(fetchFake).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFake.mock.calls[0]!;
		expect(url).toBe(LOOKUP);
		expect(init?.headers).toEqual({
			'User-Agent': 'Ask214-skillbridge-finder (+https://ask214.com/about)',
			Accept: 'application/json'
		});
		expect(init?.redirect).toBe('error');
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it('reports an empty content type when the server sent none', async () => {
		const { body } = chunkedBody(1, 4);
		const fetchFake = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(body, { status: 200 }))
		);
		const reply = await createHttp(fetchFake)(LOOKUP);
		expect(reply.contentType).toBe('');
		expect(reply.body).toBe('aaaa');
	});

	it.each([
		'http://api.skillbridge.mil/Location/Lookup',
		'https://evil.example/Location/Lookup',
		'https://api.skillbridge.mil.evil.example/Location/Lookup',
		'https://api.skillbridge.mil@evil.example/Location/Lookup',
		'https://api.skillbridge.mil:8443/Location/Lookup',
		'not a url'
	])('refuses %s before any request is made', async (url) => {
		const fetchFake = vi.fn<typeof fetch>();
		await expect(createHttp(fetchFake)(url)).rejects.toThrow('E_OFF_HOST');
		expect(fetchFake).not.toHaveBeenCalled();
	});

	it('rejects a body past 20 MiB without reading the rest of the stream', async () => {
		const { body, pulls } = chunkedBody(200, MIB);
		const fetchFake = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(body, { status: 200 }))
		);
		await expect(createHttp(fetchFake)(LOOKUP)).rejects.toThrow('E_BODY_TOO_BIG');
		expect(pulls()).toBeLessThan(30);
	});

	it('accepts a body of exactly 20 MiB', async () => {
		const { body } = chunkedBody(20, MIB);
		const fetchFake = vi.fn<typeof fetch>(() =>
			Promise.resolve(new Response(body, { status: 200 }))
		);
		const reply = await createHttp(fetchFake)(LOOKUP);
		expect(reply.body).toHaveLength(20 * MIB);
	});
});
