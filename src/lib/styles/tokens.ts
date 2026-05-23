/**
 * Design tokens. CSS variables emitted via `app.css`.
 * This typed copy is for tests, computed-style verification, and
 * any TypeScript code that needs to reference token values at runtime.
 *
 * Colors verified for WCAG 2.2 AA contrast on a dark surface:
 * - bg + fg: ~14.6:1
 * - bg + fgMuted: ~7.5:1
 * - bg + accent: ~5.4:1
 * All exceed the 4.5:1 normal-text threshold.
 */

export const tokens = {
	color: {
		bg: '#0f1419',
		fg: '#e6e8eb',
		fgMuted: '#9aa3ad',
		accent: '#4a90e2',
		accentMuted: '#3a6fb2',
		danger: '#d97757',
		success: '#6fb37a',
		border: '#2a313a'
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
		xxl: '28px'
	}
} as const;

export type Tokens = typeof tokens;
