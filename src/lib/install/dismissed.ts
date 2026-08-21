/**
 * Whether the user dismissed the Home install nudge - a non-PII device preference in localStorage,
 * like the theme choice. The permanent Settings install control ignores this; the erase clears it
 * along with all other local storage.
 */
const KEY = 'mtc:install-nudge-dismissed';

export function isNudgeDismissed(): boolean {
	try {
		return localStorage.getItem(KEY) === '1';
	} catch {
		return false;
	}
}

export function dismissNudge(): void {
	try {
		localStorage.setItem(KEY, '1');
	} catch {
		// Storage disabled (private mode): a non-dismiss is acceptable - the nudge simply reappears.
	}
}
