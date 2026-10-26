import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The setup tells a person what a PIN does not protect, so each of those lines must stay in the row as written: a line
// shortened or dropped here would promise more than the PIN gives.
const row = readFileSync(new URL('../components/AppLockRow.svelte', import.meta.url), 'utf8');

const DOES_NOT_COVER = [
	'What a PIN does not cover',
	'Ask, Resources and Documents stay open.',
	'It does not protect the data if someone copies it off the phone.',
	'Using the app in another browser? Set a PIN there too.',
	'Calendar events and calendar files you saved are not covered.',
	"Anyone holding your phone can still erase the app's data.",
	'Switching away for a short time does not lock the app. Tap Lock before you hand your phone over.'
];

describe('the App lock setup copy', () => {
	it.each(DOES_NOT_COVER)('states "%s" as written', (line) => {
		expect(row.includes(line)).toBe(true);
	});

	it('states the easy-PIN warning and its two choices as written', () => {
		for (const line of ['This PIN is easy to guess.', 'Choose another', 'Use it anyway']) {
			expect(row.includes(line), line).toBe(true);
		}
	});
});
