import { describe, it, expect, vi, afterEach } from 'vitest';
import type { HandleClientError } from '@sveltejs/kit';
import { handleError, init } from './hooks.client';
import { getDiagnosticsForTest } from '$lib/log/safelog';

// The start-up hook installs the catcher on the window. This project runs in Node, so the window is a real event
// target standing in for it; the catcher's own behaviour in a browser is tested beside it in src/lib/log.
describe('init', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('installs the error catcher before the app starts', async () => {
		const target = new EventTarget();
		vi.stubGlobal('window', target);
		await init();
		const ev = new Event('error', { cancelable: true });
		target.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
	});
});

type Input = Parameters<HandleClientError>[0];
const event = {} as Input['event'];

describe('handleError', () => {
	it("shows SvelteKit's own fixed message, never the error's text, and logs only E_INTERNAL", async () => {
		const before = getDiagnosticsForTest().length;
		const shown = await handleError({
			error: new Error('bad date 2026-11-01'),
			event,
			status: 500,
			message: 'Internal Error'
		});
		expect(shown).toEqual({ message: 'Internal Error' });
		expect(
			getDiagnosticsForTest()
				.slice(before)
				.map((e) => e.code)
		).toEqual(['E_INTERNAL']);
	});

	it('keeps the not-found message a missing page already shows', async () => {
		const shown = await handleError({
			error: new Error('x'),
			event,
			status: 404,
			message: 'Not Found'
		});
		expect(shown).toEqual({ message: 'Not Found' });
	});
});
