import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markBackupIntent, takeBackupIntent } from './intent';

// A history entry that records every replaceState the way the browser applies it.
type Entry = { state: Record<string, unknown> | null; url: string };

let entry: Entry;
let replaceState: ReturnType<typeof vi.fn>;

beforeEach(() => {
	entry = { state: null, url: '/settings' };
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
});

afterEach(() => {
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

	// A page opened fresh has no history state at all; reading for a note must not throw there.
	it('take on an entry with no state returns false and writes nothing', () => {
		expect(takeBackupIntent('restore-row')).toBe(false);
		expect(replaceState).not.toHaveBeenCalled();
	});

	// The page reads the note once; a second read, or a reload after the first, must not act on it again.
	it('take removes only its own key and returns true once', () => {
		entry.state = { 'sveltekit:history': 3, mtcBackupIntent: 'restored' };
		expect(takeBackupIntent('restored')).toBe(true);
		expect(entry.state).toEqual({ 'sveltekit:history': 3 });
		expect(takeBackupIntent('restored')).toBe(false);
		expect(entry.state).toEqual({ 'sveltekit:history': 3 });
	});

	// A page that asks for one intent must not eat the other, and a foreign value is never acted on.
	it.each([
		['the other intent', 'restore-row'],
		['an unknown value', 'something-else'],
		['a non-string value', 7]
	])('take ignores %s and leaves the state alone', (_name, value) => {
		entry.state = { 'sveltekit:history': 3, mtcBackupIntent: value };
		expect(takeBackupIntent('restored')).toBe(false);
		expect(entry.state).toEqual({ 'sveltekit:history': 3, mtcBackupIntent: value });
		expect(replaceState).not.toHaveBeenCalled();
	});
});
