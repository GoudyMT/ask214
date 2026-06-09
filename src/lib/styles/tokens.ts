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

export type Tokens = typeof tokens;
