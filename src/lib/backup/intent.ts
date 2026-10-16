/**
 * A one-word note that survives a page reload, so the page that comes up can tell why it was reloaded.
 *
 * It lives in the history entry's state and nowhere else: nothing goes in the path, the query or the fragment, so
 * nothing reaches the address bar or a history sync. The raw `history` calls are deliberate. SvelteKit keeps the
 * entry's state across a reload (its start-up spreads whatever `history.state` holds), which is what carries the note
 * through `location.reload()`, and clearing the state with `replaceState(null, '')` would delete the history index
 * SvelteKit reads for back and forward. So a write keeps every key already there and a take removes only its own.
 * SvelteKit's development build warns about a raw `replaceState`; that warning is expected.
 */
const KEY = 'mtcBackupIntent';

export type BackupIntent = 'restore-row' | 'restored';

/** Leave `intent` in the current history entry and move its address to `path`. */
export function markBackupIntent(intent: BackupIntent, path: string): void {
	history.replaceState({ ...(history.state ?? {}), [KEY]: intent }, '', path);
}

/**
 * True once, and only when the entry holds exactly `expected`: the note is removed as it is read, so a second take
 * and a reload see nothing. Any other value, or none, is ignored and left alone.
 */
export function takeBackupIntent(expected: BackupIntent): boolean {
	const state = history.state ?? {};
	if (state[KEY] !== expected) return false;
	const rest = { ...state };
	delete rest[KEY];
	history.replaceState(rest, '');
	return true;
}
