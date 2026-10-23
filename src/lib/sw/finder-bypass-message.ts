// The question a page asks the worker in charge before the finder downloads anything (finder-bypass.ts). It imports
// nothing, so the service worker can read it without carrying the app's code.

export const FINDER_BYPASS = 'finder-bypass';

/**
 * The worker's side: a worker that passes /skillbridge-data/ straight to the network says so on the port it was handed.
 * A worker from before the bypass has no such handler and stays silent, which the page reads as no.
 */
export function answerFinderBypass(event: { data: unknown; ports: readonly MessagePort[] }): void {
	const { data } = event;
	if (typeof data !== 'object' || data === null) return;
	if ((data as { type?: unknown }).type !== FINDER_BYPASS) return;
	event.ports[0]?.postMessage({ type: FINDER_BYPASS, bypass: true });
}
