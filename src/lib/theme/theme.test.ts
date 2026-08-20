import { describe, it, expect } from 'vitest';
import {
	attrForChoice,
	parseChoice,
	isThemeChoice,
	readChoice,
	applyChoice,
	persistChoice,
	syncThemeColor,
	BG_DARK,
	BG_LIGHT,
	THEME_KEY
} from './theme';
import { tokens, tokensLight } from '$lib/styles/tokens';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('theme choice logic', () => {
	it('THEME_KEY is the non-PII mtc namespace', () => {
		expect(THEME_KEY).toBe('mtc:theme');
	});
	it('attrForChoice: system -> null (no attribute), explicit -> itself', () => {
		expect(attrForChoice('system')).toBeNull();
		expect(attrForChoice('light')).toBe('light');
		expect(attrForChoice('dark')).toBe('dark');
	});
	it('parseChoice defaults unknown/absent to system', () => {
		expect(parseChoice('light')).toBe('light');
		expect(parseChoice('dark')).toBe('dark');
		expect(parseChoice('system')).toBe('system');
		expect(parseChoice(null)).toBe('system');
		expect(parseChoice('bogus')).toBe('system');
	});
	it('isThemeChoice guards the union', () => {
		expect(isThemeChoice('dark')).toBe(true);
		expect(isThemeChoice('auto')).toBe(false);
		expect(isThemeChoice(3)).toBe(false);
	});
});

describe('theme DOM/storage side effects degrade safely without a browser', () => {
	it('readChoice returns system when storage is unavailable', () => {
		expect(readChoice()).toBe('system');
	});
	it('applyChoice is a no-op (no throw) when document is undefined', () => {
		expect(() => applyChoice('dark')).not.toThrow();
	});
	it('persistChoice is a no-op (no throw) when storage is unavailable', () => {
		expect(() => persistChoice('dark')).not.toThrow();
	});
	it('syncThemeColor is a no-op (no throw) when document is undefined', () => {
		expect(() => syncThemeColor('light')).not.toThrow();
	});
});

describe('theme-color background constants', () => {
	it('mirror the bg tokens so the address-bar tint cannot drift from the palette', () => {
		expect(BG_DARK).toBe(tokens.color.bg);
		expect(BG_LIGHT).toBe(tokensLight.color.bg);
	});
});

describe('theme-color head metas mirror the bg constants', () => {
	const layout = readFileSync(
		fileURLToPath(new URL('../../routes/+layout.svelte', import.meta.url)),
		'utf8'
	);
	const metaHexes = [...layout.matchAll(/<meta name="theme-color" content="(#[0-9a-f]{6})"/gi)]
		.map((m) => m[1])
		.filter((h): h is string => h !== undefined);
	it('declares exactly two theme-color metas', () => {
		expect(metaHexes).toHaveLength(2);
	});
	it('their hexes are the dark and light backgrounds (no third, un-parity-tested copy)', () => {
		expect(new Set(metaHexes)).toEqual(new Set([BG_DARK, BG_LIGHT]));
	});
});
