/**
 * The real network and clock for the pull. Thin on purpose: the rules live in `pull-core.ts`; this only makes
 * sure a request can go nowhere but the one host, names us, follows no redirect, and cannot fill memory.
 */

import { API_ORIGIN, REQUEST_TIMEOUT_MS, USER_AGENT } from './config.ts';
import type { Clock, Http } from './pull-core.ts';

/** A larger reply than this is not a listing page; reading stops there. */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

function isOnHost(url: string): boolean {
	try {
		return new URL(url).origin === API_ORIGIN;
	} catch {
		return false;
	}
}

/** Reads the body chunk by chunk and gives up the moment it passes the cap, never holding more than that. */
async function readCapped(response: Response): Promise<string> {
	if (response.body === null) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		bytes += value.byteLength;
		if (bytes > MAX_BODY_BYTES) {
			await reader.cancel();
			throw new Error('E_BODY_TOO_BIG');
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

export function createHttp(fetchImpl?: typeof fetch): Http {
	return async (url) => {
		if (!isOnHost(url)) throw new Error('E_OFF_HOST');
		const doFetch = fetchImpl ?? globalThis.fetch;
		const response = await doFetch(url, {
			headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
			redirect: 'error',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
		return {
			status: response.status,
			contentType: response.headers.get('content-type') ?? '',
			body: await readCapped(response)
		};
	};
}

export const realClock: Clock = {
	now: () => Date.now(),
	sleep: (ms) =>
		new Promise((resolve) => {
			setTimeout(resolve, ms);
		})
};
