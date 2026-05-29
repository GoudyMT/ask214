import { describe, expect, it } from 'vitest';
import { tokens } from './tokens';

describe('design tokens', () => {
	it('exports a typed registry with all required token groups', () => {
		expect(tokens.color).toBeDefined();
		expect(tokens.space).toBeDefined();
		expect(tokens.radius).toBeDefined();
		expect(tokens.font).toBeDefined();
		expect(tokens.fontSize).toBeDefined();
	});

	it('provides foreground / background / accent colors as hex strings', () => {
		expect(tokens.color.bg).toMatch(/^#[0-9a-f]{6}$/i);
		expect(tokens.color.fg).toMatch(/^#[0-9a-f]{6}$/i);
		expect(tokens.color.accent).toMatch(/^#[0-9a-f]{6}$/i);
	});

	it('provides a surface containment color distinct from the background', () => {
		expect(tokens.color.surface).toMatch(/^#[0-9a-f]{6}$/i);
		expect(tokens.color.surface).not.toBe(tokens.color.bg);
	});

	it('provides spacing tokens as pixel strings ordered xs < s < m < l < xl < xxl', () => {
		const parse = (px: string) => Number.parseInt(px.replace('px', ''), 10);
		const order = ['xs', 's', 'm', 'l', 'xl', 'xxl'] as const;
		const values = order.map((key) => parse(tokens.space[key]));
		for (let i = 1; i < values.length; i++) {
			expect(values[i]).toBeGreaterThan(values[i - 1] ?? 0);
		}
	});

	it('provides font-family stacks as comma-separated lists', () => {
		expect(tokens.font.body).toContain(',');
		expect(tokens.font.mono).toContain(',');
	});

	it('provides fluid typography clamp() strings for h1/h2/h3', () => {
		expect(tokens.fontSize.fluid).toBeDefined();
		expect(tokens.fontSize.fluid.h1).toMatch(/^clamp\(/);
		expect(tokens.fontSize.fluid.h2).toMatch(/^clamp\(/);
		expect(tokens.fontSize.fluid.h3).toMatch(/^clamp\(/);
	});
});
