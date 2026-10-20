import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizePhrase } from './phrase';
import { BackupSession, type StartApp } from './session.svelte';

// The rules that need what the node suite fakes: the real worker and its real answers, the real window, a real input
// element in the real body, and Svelte's own flushSync.

const app: StartApp = { status: 'ready', joinRelock: () => () => {}, publish: () => {} };

// A headless test page may not have focus; the start gate is covered with a fake in the node suite.
const focused = { isVisible: () => true, hasFocus: () => true };

afterEach(() => {
	vi.restoreAllMocks();
	for (const input of document.body.querySelectorAll('input[type="file"]')) input.remove();
});

describe('the session against the real browser', () => {
	// The page and the worker agree on the protocol only if this runs: a changed answer shape fails here, not on a phone.
	it('shows six plain words from the real worker, and a derive names the first word that is not on the list', async () => {
		const s = new BackupSession(focused);
		s.start(app, 'export');
		await s.showPassphrase();
		expect(s.phase).toBe('phrase-shown');
		expect(s.words).toHaveLength(6);
		expect(s.words?.every((word) => /^[a-z]+$/.test(word))).toBe(true);
		expect(s.names?.label).toMatch(/^Ask 214 backup \d{4}-\d{2}-\d{2} [A-Z2-7]{4}$/);

		s.enterPhase('typed-back');
		const run = s.beginRun();
		expect(run).not.toBeNull();
		const canonical = canonicalizePhrase('qqqqq qqqqq qqqqq qqqqq qqqqq qqqqq');
		if (!canonical.ok || run === null) throw new Error('E_TEST_SETUP');
		const pass = canonical.bytes.buffer;
		const result = await s.derive(run, {
			purpose: 'export',
			pass,
			salt: new Uint8Array(16)
		});
		expect(result).toEqual({ ok: false, code: 'E_NOT_A_WORD', position: 1 });
		// The real post transferred the buffer: the page's copy is gone.
		expect(pass.byteLength).toBe(0);
		s.end();
	});

	// Without a picker the session builds its own input; it must sit in the body (a route can unmount under the system
	// chooser), carry no accept (a renamed backup must stay choosable), and not outlive the choice.
	it('falls back to a hidden body-level input with no accept that is removed after change, cancel and a clear', async () => {
		const s = new BackupSession({ ...focused, getOpenPicker: () => null });
		s.start(app, 'restore');

		const chosen = s.chooseFile();
		const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
		expect(input).not.toBeNull();
		if (input === null) return;
		expect(input.parentElement).toBe(document.body);
		expect(input.hasAttribute('accept')).toBe(false);
		expect(input.hidden).toBe(true);
		const file = new File(['x'], 'backup.json');
		const transfer = new DataTransfer();
		transfer.items.add(file);
		input.files = transfer.files;
		input.dispatchEvent(new Event('change'));
		expect((await chosen)?.name).toBe('backup.json');
		expect(input.isConnected).toBe(false);

		const second = s.chooseFile();
		const cancelled = document.body.querySelector<HTMLInputElement>('input[type="file"]');
		cancelled?.dispatchEvent(new Event('cancel'));
		await expect(second).resolves.toBeNull();
		expect(cancelled?.isConnected).toBe(false);

		const third = s.chooseFile();
		const open = document.body.querySelector('input[type="file"]');
		expect(open?.isConnected).toBe(true);
		s.relockSync('user');
		expect(open?.isConnected).toBe(false);
		await expect(third).resolves.toBeNull();
	});

	// The page leaving is a real window event; the session must hear it, and stop listening when it ends.
	it('clears on the real window pagehide and removes its listener when it ends', () => {
		const remove = vi.spyOn(window, 'removeEventListener');
		const s = new BackupSession(focused);
		s.start(app, 'check');
		window.dispatchEvent(new Event('pagehide'));
		expect(s.phase).toBe('idle');
		expect(s.message).toBe('E_LOCKED');
		expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
	});

	// The screen must follow the hide in the same task: a flush that waits for a microtask could lose the race with the
	// system's picture of the app.
	it('conceals through the real flushSync so a subscriber has seen it before the relock returns', () => {
		const s = new BackupSession(focused);
		s.start(app, 'check');
		const seen: boolean[] = [];
		const stop = $effect.root(() => {
			$effect(() => {
				seen.push(s.concealed);
			});
		});
		flushSync();
		expect(seen).toEqual([false]);
		s.relockSync('hygiene');
		expect(seen).toEqual([false, true]);
		stop();
		s.end();
	});
});
