import { describe, it, expect } from 'vitest';
import { capQuery } from './query-cap';

describe('capQuery', () => {
	it('trims and passes a short query unchanged', () => {
		expect(capQuery('  hello  ', 512)).toBe('hello');
	});
	it('leaves a query exactly at the cap unchanged', () => {
		expect(capQuery('abcde', 5)).toBe('abcde');
	});
	it('truncates a query beyond the char budget', () => {
		expect(capQuery('x'.repeat(1000), 512).length).toBe(512);
	});
});
