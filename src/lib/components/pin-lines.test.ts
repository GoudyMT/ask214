import { describe, expect, it } from 'vitest';
import { formatWait, triesNotice } from './pin-lines';

const SINCE = 'since your last unlock.';
const UNFINISHED = 'One PIN try did not finish.';

describe('triesNotice', () => {
	// What a person is told after a good PIN: the wrong tries since the last unlock, and a try that was cut off. The cut-off
	// try is not called wrong, because it may have been the right PIN.
	it.each([
		[0, false, []],
		[1, false, [`1 wrong PIN try ${SINCE}`]],
		[3, false, [`3 wrong PIN tries ${SINCE}`]],
		[1, true, [UNFINISHED]],
		[3, true, [`2 wrong PIN tries ${SINCE}`, UNFINISHED]],
		[2, true, [`1 wrong PIN try ${SINCE}`, UNFINISHED]]
	])('%i tries, unfinished %s -> %j', (tries, unfinished, lines) => {
		expect(triesNotice(tries, unfinished)).toEqual(lines);
	});
});

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
