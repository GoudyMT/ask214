import { describe, expect, it } from 'vitest';
import { isDamagedRecord } from '../profile/damaged';
import { KeystoreHmacMismatchError } from '../keystore/read';
import { KeystoreLockedError, WrongPinError } from '../keystore/session';

// The damaged screen offers to erase the device. A wrong PIN, or a tab that is simply locked, is nothing like damaged
// data: reading either as damage would offer an erase to a person who only mistyped.
describe('wrong-pin policy: what is not damage', () => {
	it.each([
		['a wrong PIN', () => new WrongPinError()],
		['a locked tab', () => new KeystoreLockedError()]
	])('%s never opens the damaged screen', (_name, make) => {
		expect(isDamagedRecord(make())).toBe(false);
	});

	// A control: the check is not one that answers false to everything.
	it('still reads a key record that fails its check as damage', () => {
		expect(isDamagedRecord(new KeystoreHmacMismatchError())).toBe(true);
	});
});
