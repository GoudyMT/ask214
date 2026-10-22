import { describe, it, expect } from 'vitest';
import { withinOneEdit } from './typo';

describe('withinOneEdit', () => {
	// The three slips of a thumb on a phone keyboard: a wrong key, an extra key, a missed key.
	it.each([
		['welder', 'welder'],
		['welder', 'weldor'],
		['welder', 'welderr'],
		['welder', 'welde'],
		['welder', 'elder'],
		['welder', 'wlder'],
		['a', ''],
		['', 'a']
	])('accepts %s vs %s', (a, b) => {
		expect(withinOneEdit(a, b)).toBe(true);
		expect(withinOneEdit(b, a)).toBe(true);
	});

	it.each([
		['welder', 'weldxx'],
		['welder', 'wedler'],
		['welder', 'weld'],
		['welder', 'welderxx'],
		['ab', 'ba'],
		['', 'ab']
	])('refuses %s vs %s, which are two or more edits apart', (a, b) => {
		expect(withinOneEdit(a, b)).toBe(false);
		expect(withinOneEdit(b, a)).toBe(false);
	});
});
