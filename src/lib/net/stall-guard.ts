/**
 * How long a download may go with nothing arriving before it is given up, in ms.
 *
 * A connection that is up but silent never fails on its own: the browser waits minutes, and every loading line
 * that waits on it waits that long too. The reader's page view has given up after 30 s with nothing arriving since
 * it shipped, and the same bound holds here. It is a bound, not a measured limit: a slow download that keeps
 * arriving is never cut, however long it takes, so the bound needs to cover only the gap between two pieces.
 */
export const STALL_MS = 30_000;

const STALL_ERROR = 'E_DOWNLOAD_STALLED';

type GuardOptions = {
	idleMs: number;
	// A stop from the caller. It stops the download and reads as a stop, never as a stall.
	signal?: AbortSignal;
	// Called once when the download is given up as stalled - before the error reaches whatever reads the body, which
	// may report it under its own error (the Cache API does).
	onStall?: () => void;
};

/**
 * Fetch a file and give it up when nothing arrives for `idleMs` - before the headers, or between two pieces of the
 * body. The download itself is stopped then, not only the wait for it.
 *
 * The response comes back with its status and headers and a body that carries the guard, so the caller reads or
 * stores it as it would the original.
 *
 * @param fetchFn The fetch to use; given the path and the signal that stops it.
 * @param path The file to fetch.
 * @param options The idle bound, the caller's stop, and what to call on a stall.
 * @returns The guarded response. Rejects, and the body errors, with an error `isStall` recognizes.
 */
export async function guardedFetch(
	fetchFn: (path: string, init: RequestInit) => Promise<Response>,
	path: string,
	{ idleMs, signal, onStall }: GuardOptions
): Promise<Response> {
	const inner = new AbortController();
	const stalled = new Error(STALL_ERROR);
	// Where a stall is reported: the wait for the headers first, then the body.
	let fail: (error: Error) => void = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const finish = () => {
		clearTimeout(timer);
		signal?.removeEventListener('abort', forward);
	};
	// A stop ends the wait too, so a stopped download is never reported as stalled.
	const forward = () => {
		finish();
		inner.abort(signal?.reason);
	};
	signal?.addEventListener('abort', forward, { once: true });
	if (signal?.aborted) forward();
	const wait = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			finish();
			onStall?.();
			fail(stalled);
			inner.abort(stalled);
		}, idleMs);
	};

	const response = await new Promise<Response>((resolve, reject) => {
		fail = reject;
		wait();
		fetchFn(path, { signal: inner.signal }).then(resolve, (error: unknown) => {
			finish();
			reject(error);
		});
	});
	if (response.body === null) {
		finish();
		return response;
	}
	// Each piece restarts the wait; the end of the body ends it, and so does a body that fails or is cancelled.
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			fail = (error) => controller.error(error);
			wait();
		},
		transform(chunk, controller) {
			wait();
			controller.enqueue(chunk);
		},
		flush: finish
	});
	response.body.pipeTo(writable).catch(finish);
	return new Response(readable, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
}

/**
 * Whether an error is a download given up as stalled by `guardedFetch`.
 *
 * @param error What was thrown.
 * @returns True for a stall.
 */
export function isStall(error: unknown): boolean {
	return error instanceof Error && error.message === STALL_ERROR;
}
