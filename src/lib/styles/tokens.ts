/**
 * Design tokens. CSS variables emitted via `app.css`.
 * This typed copy is for tests, computed-style verification, and
 * any TypeScript code that needs to reference token values at runtime.
 *
 * Colors verified for WCAG 2.2 AA contrast on a dark surface:
 * - bg + fg: ~14.6:1
 * - bg + fgMuted: ~7.5:1
 * - bg + accent: ~5.4:1
 * - surface + fg: ~13:1; surface + fgMuted: ~6:1 (surface is one notch lighter
 *   than bg for card/containment; text on it still exceeds 4.5:1)
 * All exceed the 4.5:1 normal-text threshold.
 *
 * `tokensLight` below is the light palette; `contrast.test.ts` enforces WCAG AA on both.
 */

export const tokens = {
	color: {
		bg: '#0f1419',
		surface: '#171d24',
		fg: '#e6e8eb',
		fgMuted: '#9aa3ad',
		accent: '#4a90e2',
		accentMuted: '#3a6fb2',
		danger: '#d97757',
		success: '#6fb37a',
		border: '#2a313a',
		category: {
			medical: '#56b6c2',
			admin: '#8895a8',
			benefits: '#7e8ce0',
			career: '#b07fd0',
			finance: '#cbb15e'
		}
	},
	space: {
		xs: '4px',
		s: '8px',
		m: '16px',
		l: '24px',
		xl: '32px',
		xxl: '48px'
	},
	radius: {
		s: '4px',
		m: '8px',
		l: '12px'
	},
	font: {
		body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
		mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace'
	},
	fontSize: {
		s: '14px',
		base: '16px',
		l: '18px',
		xl: '22px',
		xxl: '28px',
		fluid: {
			h1: 'clamp(28px, 5vw, 40px)',
			h2: 'clamp(22px, 4vw, 28px)',
			h3: 'clamp(18px, 3vw, 22px)'
		}
	}
} as const;

/**
 * Light palette. The color subset of `tokens` (space, radius, and typography are theme-invariant,
 * so they are not duplicated). Mirrors the app.css light blocks; `contrast.test.ts` enforces WCAG AA.
 */
export const tokensLight = {
	color: {
		bg: '#f5f7fa',
		surface: '#ffffff',
		fg: '#1a1f27',
		fgMuted: '#586471',
		accent: '#1a66c2',
		accentMuted: '#3f7ec4',
		danger: '#c2410c',
		success: '#2f7d40',
		border: '#d5dae1',
		category: {
			medical: '#0e7c8a',
			admin: '#4a5568',
			benefits: '#4550b8',
			career: '#7c3fab',
			finance: '#8a6d1e'
		}
	}
} as const;

export type Tokens = typeof tokens;
