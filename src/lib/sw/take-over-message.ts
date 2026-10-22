// The message a page sends to make this release's waiting worker take over (take-over.ts). It imports nothing, so the
// service worker can read it without carrying the app's database code.

export const TAKE_OVER = 'take-over';

/** The worker's side: only a page of its own build may make it take over. */
export const isTakeOver = (data: unknown, build: string): boolean =>
	typeof data === 'object' &&
	data !== null &&
	(data as { type?: unknown }).type === TAKE_OVER &&
	(data as { build?: unknown }).build === build;
