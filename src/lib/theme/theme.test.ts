import { describe, it, expect } from 'vitest';
import {
	attrForChoice,
	parseChoice,
	isThemeChoice,
	readChoice,
	applyChoice,
	persistChoice,
	THEME_KEY
} from './theme';

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
});
