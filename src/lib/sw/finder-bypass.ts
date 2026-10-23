import { FINDER_BYPASS } from './finder-bypass-message';

/** How long a worker in charge has to answer; a worker that will answer does so at once. */
const ANSWER_DEADLINE_MS = 1500;

/**
 * Whether the finder may download now. A worker from before the bypass keeps a copy of every page-side GET it serves,
 * so it would hold on disk which region files this device fetched, and those narrow where the person is. With no worker
 * in charge the request goes straight to the network. With one, the finder downloads only when that worker answers that
 * it passes /skillbridge-data/ through; silence, or a worker that cannot be asked, is a no until the newer worker takes
 * charge.
 *
 * @param container The page's service worker container; undefined where the browser has none.
 * @param deadlineMs How long to wait for the answer.
 * @returns True when no worker is in charge or the one in charge answers that it bypasses.
 */
export function workerBypassesFinderData(
	container: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker,
	deadlineMs: number = ANSWER_DEADLINE_MS
): Promise<boolean> {
	const worker = container?.controller;
	if (!worker) return Promise.resolve(true);
	return new Promise((resolve) => {
		const { port1, port2 } = new MessageChannel();
		const done = (answer: boolean) => {
			clearTimeout(timer);
			port1.close();
			resolve(answer);
		};
		const timer = setTimeout(() => done(false), deadlineMs);
		port1.onmessage = (event: MessageEvent) =>
			done(
				(event.data as { type?: unknown; bypass?: unknown } | null)?.type === FINDER_BYPASS &&
					(event.data as { bypass?: unknown }).bypass === true
			);
		try {
			worker.postMessage({ type: FINDER_BYPASS }, [port2]);
		} catch {
			done(false);
		}
	});
}
