import { describe, expect, it } from 'vitest';
import { formatWait } from './pin-lines';

describe('formatWait', () => {
	it.each([
		[1, '1 second'],
		[1_001, '2 seconds'],
		[29_001, '30 seconds'],
		[30_000, '30 seconds'],
		[59_000, '59 seconds'],
		[59_001, '1 minute'],
		[60_000, '1 minute'],
		[60_001, '2 minutes'],
		[300_000, '5 minutes'],
		[900_000, '15 minutes']
	])('%i ms reads %s', (ms, line) => {
		expect(formatWait(ms)).toBe(line);
	});
});
