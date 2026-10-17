/**
 * A one-word note that survives a page reload, so the page that comes up can tell why it was reloaded.
 *
 * It lives in the history entry's state and nowhere else: nothing goes in the path, the query or the fragment, so
 * nothing reaches the address bar or a history sync. The raw `history` calls are deliberate. The entry's state is
 * what carries the note through `location.reload()`, but SvelteKit does not keep it: on a page it does not prerender
 * its start-up replaces the entry with only its own keys. So the client init hook captures the note first (see
 * `captureBackupIntent`) and the page takes it from there. Clearing the state with `replaceState(null, '')` would
 * delete the history index SvelteKit reads for back and forward, so a write keeps every key already there and a
 * capture or take removes only its own. SvelteKit's development build warns about a raw `replaceState`; that warning
 * is expected.
 */
const KEY = 'mtcBackupIntent';

export type BackupIntent = 'restore-row' | 'restored';

let captured: BackupIntent | null = null;

/**
 * Read the note out of the entry once, at start-up, before SvelteKit touches the entry. Called from the client init hook.
 * A page that is not prerendered is started by SvelteKit replacing the entry with its own two index keys, which drops
 * any other key before a page can read it; so the note is held here, and the entry is cleared of it so a reload of the
 * landed page carries none.
 */
export function captureBackupIntent(): void {
	try {
		const state = history.state ?? {};
		const value: unknown = state[KEY];
		if (value !== 'restore-row' && value !== 'restored') return;
		captured = value;
		const rest = { ...state };
		delete rest[KEY];
		history.replaceState(rest, '');
	} catch {
		// A browser that refuses the history read or write just has no note; the app must still start.
	}
}

/** Leave `intent` in the current history entry and move its address to `path`. */
export function markBackupIntent(intent: BackupIntent, path: string): void {
	history.replaceState({ ...(history.state ?? {}), [KEY]: intent }, '', path);
}

/**
 * True once, and only when the note is exactly `expected`: it is removed as it is read, so a second take and a reload
 * see nothing. Any other value, or none, is ignored and left alone. The note is the one start-up captured; failing
 * that, the one the entry still holds.
 */
export function takeBackupIntent(expected: BackupIntent): boolean {
	if (captured === expected) {
		captured = null;
		return true;
	}
	const state = history.state ?? {};
	if (state[KEY] !== expected) return false;
	const rest = { ...state };
	delete rest[KEY];
	history.replaceState(rest, '');
	return true;
}
