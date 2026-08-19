export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_KEY = 'mtc:theme';
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export function isThemeChoice(v: unknown): v is ThemeChoice {
	return v === 'system' || v === 'light' || v === 'dark';
}

/** The data-theme attribute value for a choice: null means remove it (System follows the OS via CSS). */
export function attrForChoice(c: ThemeChoice): 'light' | 'dark' | null {
	return c === 'system' ? null : c;
}

export function parseChoice(raw: string | null): ThemeChoice {
	return isThemeChoice(raw) ? raw : 'system';
}

/** Read the persisted choice; falls back to system when storage is unavailable (SSR, privacy mode). */
export function readChoice(): ThemeChoice {
	try {
		return parseChoice(localStorage.getItem(THEME_KEY));
	} catch {
		return 'system';
	}
}

/** Set or remove the root data-theme attribute; a no-op when there is no document (SSR). */
export function applyChoice(c: ThemeChoice): void {
	if (typeof document === 'undefined') return;
	const attr = attrForChoice(c);
	if (attr === null) document.documentElement.removeAttribute('data-theme');
	else document.documentElement.setAttribute('data-theme', attr);
}

/** Persist the choice; a no-op when storage is unavailable (the in-session attribute still applies). */
export function persistChoice(c: ThemeChoice): void {
	try {
		localStorage.setItem(THEME_KEY, c);
	} catch {
		/* storage unavailable */
	}
}

/** Persist and apply. The single entry point the control calls. */
export function setTheme(c: ThemeChoice): void {
	persistChoice(c);
	applyChoice(c);
}
