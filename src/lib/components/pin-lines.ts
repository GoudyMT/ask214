/**
 * What a PIN check says, the same wherever the PIN is asked for: the Unlock card, and Settings when the PIN is changed
 * or removed. A wrong try and a try that was not 4-6 digits read the same on purpose: the line never says which it was.
 * A small file of its own, so Settings can show these lines without loading the Unlock card.
 */
export const NOT_RIGHT_LINE = 'That PIN is not right.';
export const CHECK_LOW_MEMORY_LINE =
	'This phone ran out of memory while checking your PIN. Your PIN may be right. Close other apps and tabs, then try again.';

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;

/** A wait as a person reads it: whole seconds under a minute, else whole minutes rounded up. */
export function formatWait(ms: number): string {
	const seconds = Math.ceil(ms / MS_PER_SECOND);
	if (seconds < SECONDS_PER_MINUTE) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
	const minutes = Math.ceil(seconds / SECONDS_PER_MINUTE);
	return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export const waitLine = (ms: number): string =>
	`${NOT_RIGHT_LINE} You can try again in ${formatWait(ms)}.`;

/**
 * What a good PIN tells the person about the tries before it. A try that was cut off is not counted as wrong: it may have
 * been the right PIN. Nothing to say is an empty list, never a line about zero.
 */
export function triesNotice(wrongTries: number, unfinished: boolean): string[] {
	const wrong = unfinished ? wrongTries - 1 : wrongTries;
	return [
		...(wrong > 0
			? [`${wrong} wrong PIN ${wrong === 1 ? 'try' : 'tries'} since your last unlock.`]
			: []),
		...(unfinished ? ['One PIN try did not finish.'] : [])
	];
}
