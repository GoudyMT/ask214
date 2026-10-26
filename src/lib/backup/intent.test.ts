import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureBackupIntent, markBackupIntent, takeBackupIntent } from './intent';

// A history entry that records every replaceState the way the browser applies it.
type Entry = { state: Record<string, unknown> | null; url: string };

let entry: Entry;
let replaceState: ReturnType<typeof vi.fn>;
let pathname: string;

beforeEach(() => {
	entry = { state: null, url: '/settings' };
	pathname = '/timeline';
	replaceState = vi.fn((state: Record<string, unknown> | null, _title: string, url?: string) => {
		entry.state = state;
		if (url !== undefined) entry.url = url;
	});
	vi.stubGlobal('history', {
		get state() {
			return entry.state;
		},
		replaceState
	});
	vi.stubGlobal('location', {
		get pathname() {
			return pathname;
		}
	});
});

afterEach(() => {
	// The held note outlives a test; spend whatever a test left so it cannot reach the next one.
	pathname = '/timeline';
	takeBackupIntent('restore-row');
	takeBackupIntent('restored');
	takeBackupIntent('restored-pin-off');
	vi.unstubAllGlobals();
});

describe('backup intent', () => {
	// SvelteKit's own back/forward index lives in the same state object; losing it breaks Back after the reload.
	it('mark keeps the keys SvelteKit already put in the entry', () => {
		entry.state = { 'sveltekit:history': 3, 'sveltekit:navigation': 7 };
		markBackupIntent('restore-row', '/wizard');
		expect(entry.state).toEqual({
			'sveltekit:history': 3,
			'sveltekit:navigation': 7,
			mtcBackupIntent: 'restore-row'
		});
		expect(entry.url).toBe('/wizard');
	});

	// A page opened fresh has no history state at all; start-up and the page must not throw or write there.
	it('capture and take on an entry with no state find nothing and write nothing', () => {
		captureBackupIntent();
		expect(takeBackupIntent('restore-row')).toBe(false);
		expect(replaceState).not.toHaveBeenCalled();
	});

	// A page that is not prerendered starts with SvelteKit writing its own entry over this one, with only its index keys,
	// before any page runs. A note read only at the page would already be gone: the person was never told the restore
	// landed. Reading it at start-up, ahead of that write, is what keeps it.
	it('a note captured at start-up outlives SvelteKit rewriting the entry without it', () => {
		entry.state = { 'sveltekit:history': 3, mtcBackupIntent: 'restored' };
		captureBackupIntent();
		entry.state = { 'sveltekit:history': 3, 'sveltekit:navigation': 3, 'sveltekit:states': {} };
		expect(takeBackupIntent('restored')).toBe(true);
		expect(takeBackupIntent('restored')).toBe(false);
	});

	// The note is for one load: once captured it is out of the entry, so a reload of the landed page carries none.
	it('capture takes the note out of the entry and keeps SvelteKit keys', () => {
		entry.state = { 'sveltekit:history': 3, mtcBackupIntent: 'restore-row' };
		captureBackupIntent();
		expect(entry.state).toEqual({ 'sveltekit:history': 3 });
	});

	// A page that asks for one intent must not eat the other.
	it('take of the other intent finds nothing and leaves the held note for its own page', () => {
		entry.state = { 'sveltekit:history': 3, mtcBackupIntent: 'restore-row' };
		captureBackupIntent();
		expect(takeBackupIntent('restored')).toBe(false);
		expect(takeBackupIntent('restore-row')).toBe(true);
	});

	// A restore onto a device that was locked behind a forgotten PIN ends with the PIN off: the Timeline says that, not the
	// ordinary restored note, so the two must never be taken for each other.
	it('a restore onto a locked device leaves its own note, which the ordinary restored page does not take', () => {
		entry.state = { 'sveltekit:history': 3, mtcBackupIntent: 'restored-pin-off' };
		captureBackupIntent();
		expect(entry.state).toEqual({ 'sveltekit:history': 3 });
		expect(takeBackupIntent('restored')).toBe(false);
		expect(takeBackupIntent('restored-pin-off')).toBe(true);
		expect(takeBackupIntent('restored-pin-off')).toBe(false);
	});

	// A foreign value is never acted on, and the entry it sits in is left as it was.
	it('capture ignores an unknown value and leaves the entry alone', () => {
		entry.state = { 'sveltekit:history': 3, mtcBackupIntent: 'something-else' };
		captureBackupIntent();
		expect(takeBackupIntent('restored')).toBe(false);
		expect(takeBackupIntent('restore-row')).toBe(false);
		expect(replaceState).not.toHaveBeenCalled();
	});

	// A browser that refuses to rewrite the entry (a locked-down webview, a sandboxed frame) must not stop the app from
	// starting, and the note read just before the write is still the person's: the page takes it once.
	it('capture does not throw when the entry cannot be rewritten, and the note is still taken once', () => {
		entry.state = { 'sveltekit:history': 3, mtcBackupIntent: 'restored' };
		replaceState.mockImplementation(() => {
			throw new Error('SecurityError');
		});
		expect(() => captureBackupIntent()).not.toThrow();
		expect(takeBackupIntent('restored')).toBe(true);
		expect(takeBackupIntent('restored')).toBe(false);
	});

	// A browser that refuses the history read cannot give a note, and must not stop the app from starting either.
	it('capture does not throw when the history state cannot be read, and take finds nothing', () => {
		vi.stubGlobal('history', {
			get state(): never {
				throw new Error('SecurityError');
			},
			replaceState
		});
		expect(() => captureBackupIntent()).not.toThrow();
		expect(takeBackupIntent('restore-row')).toBe(false);
		expect(takeBackupIntent('restored')).toBe(false);
	});

	// The note is for the page it was left for. A client navigation to another page in the same document carries no new
	// load, so a note never taken on its own page must not open a row on the next one.
	it('a note left for one page is not taken on another', () => {
		entry.state = { 'sveltekit:history': 3, mtcBackupIntent: 'restore-row' };
		pathname = '/timeline';
		captureBackupIntent();
		pathname = '/wizard';
		expect(takeBackupIntent('restore-row')).toBe(false);
	});
});
