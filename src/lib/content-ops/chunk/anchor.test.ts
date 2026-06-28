import { describe, it, expect } from 'vitest';
import { computeAnchor } from './anchor';

describe('computeAnchor', () => {
	it('returns exact-only when the slice occurs once in the source', () => {
		const nt = 'The intent to file sets a potential start date for your benefits.';
		const start = nt.indexOf('sets a potential start date');
		const end = start + 'sets a potential start date'.length;
		expect(computeAnchor(nt, start, end)).toEqual({ exact: 'sets a potential start date' });
	});

	it('grows prefix and suffix from the real location to disambiguate a repeated slice', () => {
		const nt = 'apply now then apply now and finally apply now again';
		const start = nt.indexOf('apply now', 10); // the SECOND occurrence
		const end = start + 'apply now'.length;
		const a = computeAnchor(nt, start, end);
		expect(a?.exact).toBe('apply now');
		const window = (a?.prefix ?? '') + (a?.exact ?? '') + (a?.suffix ?? '');
		expect(nt.indexOf(window)).toBe(nt.lastIndexOf(window)); // unique: first == last occurrence
		expect(nt.indexOf(window)).toBeLessThanOrEqual(start); // and covers the real chunk location
	});

	it('returns null when uniqueness is unreachable within the bound', () => {
		const nt = 'ab '.repeat(200) + 'ab';
		const start = 3; // an interior 'ab'
		const end = 5;
		expect(computeAnchor(nt, start, end, 4)).toBeNull();
	});

	it('keeps prefix/suffix omitted (not undefined) when exact alone is unique', () => {
		const nt = 'unique passage here';
		const a = computeAnchor(nt, 0, 'unique'.length);
		expect(Object.prototype.hasOwnProperty.call(a, 'prefix')).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(a, 'suffix')).toBe(false);
	});
});
