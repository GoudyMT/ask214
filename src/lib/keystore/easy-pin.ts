// A PIN's first guesses: what a stranger holding the phone tries before anything else.
const UP = '0123456789';
const DOWN = '9876543210';
// One digit, or a block of 2 or 3, said again until it fills the PIN; the keypad's middle column, up or down; a year from
// 1900 to 2099.
const PATTERN = /^(?:(\d{1,3})\1+|2580|0852|(?:19|20)\d\d)$/;

/**
 * True for a PIN that is easy to guess. The caller has already checked it is 4 to 6 digits. A run up or down by one is
 * a stretch of the digits in order, which does not wrap: 7890 is not one.
 */
export function isEasyPin(pin: string): boolean {
	return PATTERN.test(pin) || UP.includes(pin) || DOWN.includes(pin);
}
