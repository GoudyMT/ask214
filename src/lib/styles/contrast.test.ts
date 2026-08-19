import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tokens, tokensLight } from './tokens';

// WCAG 2.2 relative luminance + contrast ratio. Per-channel (not an intermediate array) so the code
// stays clean under noUncheckedIndexedAccess. https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
function lum(hex: string): number {
	const channel = (i: number): number => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function cr(a: string, b: string): number {
	const la = lum(a);
	const lb = lum(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

for (const [name, t] of [
	['dark', tokens],
	['light', tokensLight]
] as const) {
	describe(`WCAG AA - ${name} palette`, () => {
		const c = t.color;
		const textOnBg: Array<[string, string]> = [
			['fg', c.fg],
			['fgMuted', c.fgMuted],
			['accent', c.accent]
		];
		for (const [label, hex] of textOnBg) {
			it(`${label} on bg >= 4.5:1`, () => expect(cr(hex, c.bg)).toBeGreaterThanOrEqual(4.5));
		}
		const textOnSurface: Array<[string, string]> = [
			['fg', c.fg],
			['fgMuted', c.fgMuted],
			['danger', c.danger],
			['success', c.success],
			['catMedical', c.category.medical],
			['catAdmin', c.category.admin],
			['catBenefits', c.category.benefits],
			['catCareer', c.category.career],
			['catFinance', c.category.finance]
		];
		for (const [label, hex] of textOnSurface) {
			it(`${label} on surface >= 4.5:1`, () =>
				expect(cr(hex, c.surface)).toBeGreaterThanOrEqual(4.5));
		}
		it('accent edge on surface >= 3:1 (UI)', () =>
			expect(cr(c.accent, c.surface)).toBeGreaterThanOrEqual(3));
	});
}

// Parity: both app.css light blocks (explicit + system) must mirror tokensLight so the two
// definitions cannot silently drift apart.
const appCss = readFileSync(fileURLToPath(new URL('../../app.css', import.meta.url)), 'utf8');

function blockAfter(css: string, marker: string): string {
	const at = css.indexOf(marker);
	const open = css.indexOf('{', at);
	const close = css.indexOf('}', open);
	return css.slice(open, close);
}

const cssVarPairs: Array<[string, string]> = [
	['--color-bg', tokensLight.color.bg],
	['--color-surface', tokensLight.color.surface],
	['--color-fg', tokensLight.color.fg],
	['--color-fg-muted', tokensLight.color.fgMuted],
	['--color-accent', tokensLight.color.accent],
	['--color-accent-muted', tokensLight.color.accentMuted],
	['--color-danger', tokensLight.color.danger],
	['--color-success', tokensLight.color.success],
	['--color-border', tokensLight.color.border],
	['--color-category-medical', tokensLight.color.category.medical],
	['--color-category-admin', tokensLight.color.category.admin],
	['--color-category-benefits', tokensLight.color.category.benefits],
	['--color-category-career', tokensLight.color.category.career],
	['--color-category-finance', tokensLight.color.category.finance]
];

for (const [blockName, marker] of [
	['explicit', ':root[data-theme='],
	['system', ':root:not([data-theme])']
] as const) {
	describe(`app.css ${blockName} light block mirrors tokensLight`, () => {
		const block = blockAfter(appCss, marker);
		for (const [cssVar, hex] of cssVarPairs) {
			it(`${cssVar} is ${hex}`, () => expect(block).toContain(`${cssVar}: ${hex};`));
		}
	});
}
