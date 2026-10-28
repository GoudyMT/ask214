import { describe, it, expect } from 'vitest';
import { guardedFetch, isStall } from './stall-guard';

const IDLE_MS = 40;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A download the test drives by hand: headers when `respond` is called, then each `send`, then `end`. Records the
// signal it was given, so a test can see whether the download itself was stopped.
function download() {
	let push!: ReadableStreamDefaultController<Uint8Array>;
	let respond!: () => void;
	let given: AbortSignal | undefined;
	const body = new ReadableStream<Uint8Array>({ start: (c) => void (push = c) });
	const fetchFn = (_path: string, init: RequestInit) => {
		given = init.signal ?? undefined;
		return new Promise<Response>((resolve, reject) => {
			// As a real fetch does: a stop rejects the wait for the headers and errors a body already arriving.
			given?.addEventListener('abort', () => {
				reject(given?.reason);
				push.error(given?.reason);
			});
			respond = () => resolve(new Response(body, { status: 200 }));
		});
	};
	return {
		fetchFn,
		respond: () => respond(),
		send: (bytes: number) => push.enqueue(new Uint8Array(bytes)),
		end: () => push.close(),
		signal: () => given
	};
}

describe('guardedFetch', () => {
	it('gives up on headers that never come, and stops the download', async () => {
		const net = download();
		let stalls = 0;
		const run = guardedFetch(net.fetchFn, '/corpus/c.json', {
			idleMs: IDLE_MS,
			onStall: () => stalls++
		});
		await expect(run).rejects.toSatisfy(isStall);
		expect(stalls).toBe(1);
		expect(net.signal()?.aborted).toBe(true);
	});

	it('gives up on a body that goes silent part-way, and stops the download', async () => {
		const net = download();
		let stalls = 0;
		const run = guardedFetch(net.fetchFn, '/docs/a.pdf', {
			idleMs: IDLE_MS,
			onStall: () => stalls++
		});
		net.respond();
		const response = await run;
		net.send(10);
		await expect(response.arrayBuffer()).rejects.toSatisfy(isStall);
		expect(stalls).toBe(1);
		expect(net.signal()?.aborted).toBe(true);
	});

	it('never cuts a slow download that keeps arriving', async () => {
		const net = download();
		let stalls = 0;
		const run = guardedFetch(net.fetchFn, '/docs/a.pdf', {
			idleMs: IDLE_MS,
			onStall: () => stalls++
		});
		await pause(IDLE_MS / 2);
		net.respond();
		const response = await run;
		const read = response.arrayBuffer();
		// More than three times the idle bound in all, never the bound between two chunks.
		for (let i = 0; i < 8; i++) {
			await pause(IDLE_MS / 2);
			net.send(5);
		}
		net.end();
		expect((await read).byteLength).toBe(40);
		await pause(IDLE_MS * 2);
		expect(stalls).toBe(0);
		expect(net.signal()?.aborted).toBe(false);
	});

	// The answer library reads its two files one after the other: the second must not be cut while it waits its turn,
	// its bytes still arriving.
	it('never cuts a download that nobody is reading yet', async () => {
		const net = download();
		let stalls = 0;
		const run = guardedFetch(net.fetchFn, '/corpus/c.embeddings.bin', {
			idleMs: IDLE_MS,
			onStall: () => stalls++
		});
		net.respond();
		const response = await run;
		for (let i = 0; i < 6; i++) {
			await pause(IDLE_MS / 2);
			net.send(5);
		}
		await pause(IDLE_MS * 2);
		net.end();
		expect((await response.arrayBuffer()).byteLength).toBe(30);
		expect(stalls).toBe(0);
		expect(net.signal()?.aborted).toBe(false);
	});

	it('reports a connection lost part-way as its own error, never as a stall', async () => {
		let push!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({ start: (c) => void (push = c) });
		let stalls = 0;
		const response = await guardedFetch(
			async () => new Response(body, { status: 200 }),
			'/docs/a.pdf',
			{ idleMs: IDLE_MS, onStall: () => stalls++ }
		);
		const read = response.arrayBuffer();
		push.enqueue(new Uint8Array(4));
		push.error(new TypeError('E_TEST_LOST'));
		await expect(read).rejects.not.toSatisfy(isStall);
		await pause(IDLE_MS * 2);
		expect(stalls).toBe(0);
	});

	it('passes a stop part-way through the body as a stop, not a stall', async () => {
		const net = download();
		const stop = new AbortController();
		let stalls = 0;
		const run = guardedFetch(net.fetchFn, '/docs/a.pdf', {
			idleMs: IDLE_MS,
			signal: stop.signal,
			onStall: () => stalls++
		});
		net.respond();
		const read = (await run).arrayBuffer();
		net.send(10);
		stop.abort();
		await expect(read).rejects.not.toSatisfy(isStall);
		await pause(IDLE_MS * 2);
		expect(stalls).toBe(0);
	});

	it('passes a stop from the caller through as a stop, not a stall', async () => {
		const net = download();
		const stop = new AbortController();
		let stalls = 0;
		const run = guardedFetch(net.fetchFn, '/docs/a.pdf', {
			idleMs: IDLE_MS,
			signal: stop.signal,
			onStall: () => stalls++
		});
		stop.abort();
		await expect(run).rejects.not.toSatisfy(isStall);
		expect(net.signal()?.aborted).toBe(true);
		await pause(IDLE_MS * 2);
		expect(stalls).toBe(0);
	});

	it('keeps the status and headers, so a stored copy is the same response', async () => {
		const fetchFn = async () =>
			new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } });
		const response = await guardedFetch(fetchFn, '/corpus/c.json', { idleMs: IDLE_MS });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(await response.json()).toEqual({ a: 1 });
	});
});
