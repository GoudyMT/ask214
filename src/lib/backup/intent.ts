/**
 * A one-word note that survives a page reload, so the page that comes up can tell why it was reloaded.
 *
 * It lives in the history entry's state and nowhere else: nothing goes in the path, the query or the fragment, so
 * nothing reaches the address bar or a history sync. The raw `history` calls are deliberate. The entry's state is
 * what carries the note through `location.reload()`, but SvelteKit does not keep it: the pages that carry personal
 * data set `ssr = false`, so the server sends no hydration payload and SvelteKit's start-up replaces the entry with
 * only its own keys. So the client init hook captures the note first (see `captureBackupIntent`) and the page takes it
 * from there. Clearing the state with `replaceState(null, '')` would delete the history index SvelteKit reads for back
 * and forward, so a write keeps every key already there and a capture removes only its own. SvelteKit's development
 * build warns about a raw `replaceState`; that warning is expected.
 */
const KEY = 'mtcBackupIntent';

/** `restored-pin-off`: the restore was onto a device locked behind a forgotten PIN, so the PIN is off afterwards. */
export type BackupIntent = 'restore-row' | 'restored' | 'restored-pin-off';

/** The note start-up read, and the page it was left for. */
let held: { intent: BackupIntent; path: string } | null = null;

/**
 * Read the note out of the entry once, at start-up, before SvelteKit touches the entry. Called from the client init hook.
 * SvelteKit's start-up replaces the entry with its own keys, which drops any other key before a page can read it; so
 * the note is held here with the page it was left for, and the entry is cleared of it, so a reload of the landed page
 * finds none.
 */
export function captureBackupIntent(): void {
	try {
		const state = history.state ?? {};
		const value: unknown = state[KEY];
		if (value !== 'restore-row' && value !== 'restored' && value !== 'restored-pin-off') return;
		held = { intent: value, path: location.pathname };
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
 * True once, and only when the note start-up captured is exactly `expected` and was left for the page now showing: a
 * client navigation to another page in the same document is not a load, so it takes nothing. A second take sees
 * nothing. Any other value, or none, is ignored and left alone.
 */
export function takeBackupIntent(expected: BackupIntent): boolean {
	if (held === null || held.intent !== expected || held.path !== location.pathname) return false;
	held = null;
	return true;
}
