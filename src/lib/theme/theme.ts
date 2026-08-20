export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_KEY = 'mtc:theme';
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

// The mobile address-bar tint (the two <meta name="theme-color"> tags in the layout head). These
// mirror tokens.color.bg / tokensLight.color.bg; a unit test pins the parity so they cannot drift.
export const BG_DARK = '#0f1419';
export const BG_LIGHT = '#f5f7fa';

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

/**
 * Point the theme-color metas at the active palette's background so the mobile address bar matches.
 * System (no explicit choice) is left to the two prefers-color-scheme metas, which track the OS live;
 * an explicit Light/Dark overrides both. A no-op without a document (SSR).
 */
export function syncThemeColor(c: ThemeChoice): void {
	if (typeof document === 'undefined') return;
	const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
	if (c === 'system') {
		// Restore the OS-driven pair: the prefers-color-scheme:light meta -> light, the default -> dark.
		metas.forEach((m) => {
			m.content = m.media ? BG_LIGHT : BG_DARK;
		});
	} else {
		const color = c === 'light' ? BG_LIGHT : BG_DARK;
		metas.forEach((m) => {
			m.content = color;
		});
	}
}

/** Persist and apply (palette + address-bar tint). The single entry point the control calls. */
export function setTheme(c: ThemeChoice): void {
	persistChoice(c);
	applyChoice(c);
	syncThemeColor(c);
}
