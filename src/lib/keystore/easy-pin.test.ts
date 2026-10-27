import { describe, expect, it } from 'vitest';
import { isEasyPin } from './easy-pin';

// Each rule has its own PINs, so removing one rule fails exactly its group.
describe('isEasyPin: the PINs a stranger tries first', () => {
	it.each(['1111', '0000', '99999', '000000'])('one digit repeated: %s', (pin) => {
		expect(isEasyPin(pin)).toBe(true);
	});

	it.each(['1234', '4321', '0123', '3210', '12345', '456789', '987654'])(
		'a run up or down by one across the whole PIN: %s',
		(pin) => {
			expect(isEasyPin(pin)).toBe(true);
		}
	);

	it.each(['1212', '4747', '121212', '123123', '908908'])(
		'a block of 2 or 3 digits repeated to fill the PIN: %s',
		(pin) => {
			expect(isEasyPin(pin)).toBe(true);
		}
	);

	it.each(['2580', '0852'])('the middle column of the keypad, up or down: %s', (pin) => {
		expect(isEasyPin(pin)).toBe(true);
	});

	it.each(['1900', '1987', '2024', '2099'])('a year from 1900 to 2099: %s', (pin) => {
		expect(isEasyPin(pin)).toBe(true);
	});
});

describe('isEasyPin: PINs off the list', () => {
	it.each([
		'135790',
		'246802',
		'5739',
		'13579',
		// A run does not wrap from 9 to 0 or from 0 to 9.
		'7890',
		'9012',
		// Not a repeated block: the pairs differ, or the block does not fill the PIN.
		'121213',
		'12123',
		// The years' edges.
		'1899',
		'2100',
		// A year is a rule for 4 digits only.
		'20245',
		'202400'
	])('%s is not easy', (pin) => {
		expect(isEasyPin(pin)).toBe(false);
	});
});
