// A PIN's first guesses: what a stranger holding the phone tries before anything else.
const KEYPAD_MIDDLE_COLUMN = ['2580', '0852'];
const BLOCK_SIZES = [2, 3];
const FIRST_YEAR = 1900;
const LAST_YEAR = 2099;
const YEAR_DIGITS = 4;

function isOneDigit(pin: string): boolean {
	return [...pin].every((digit) => digit === pin[0]);
}

// Up or down by one at every step, with no wrap: 7890 and 9012 are not runs.
function isRun(pin: string): boolean {
	const digits = [...pin].map(Number);
	const step = (digits[1] ?? 0) - (digits[0] ?? 0);
	return (
		(step === 1 || step === -1) &&
		digits.every((digit, i) => i === 0 || digit - (digits[i - 1] ?? 0) === step)
	);
}

// A short block said again until it fills the PIN exactly.
function isRepeatedBlock(pin: string): boolean {
	return BLOCK_SIZES.some(
		(size) =>
			pin.length > size &&
			pin.length % size === 0 &&
			pin === pin.slice(0, size).repeat(pin.length / size)
	);
}

function isYear(pin: string): boolean {
	return pin.length === YEAR_DIGITS && Number(pin) >= FIRST_YEAR && Number(pin) <= LAST_YEAR;
}

/** True for a PIN that is easy to guess. The caller has already checked it is 4 to 6 digits. */
export function isEasyPin(pin: string): boolean {
	return (
		isOneDigit(pin) ||
		isRun(pin) ||
		isRepeatedBlock(pin) ||
		KEYPAD_MIDDLE_COLUMN.includes(pin) ||
		isYear(pin)
	);
}
