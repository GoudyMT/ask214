import { describe, it, expect } from 'vitest';
import { detectCrisisIntent } from './detect';

describe('detectCrisisIntent', () => {
	it.each([
		'I want to kill myself',
		"I've been feeling suicidal since I got my orders",
		'honestly there is no reason to go on',
		"I don't want to be here anymore after I get out",
		'I would be better off dead',
		'I keep thinking about ending my life',
		'sometimes I just want to die',
		"I can't go on like this"
	])('fires on a clear crisis message: %s', (q) => {
		expect(detectCrisisIntent(q).crisis).toBe(true);
	});

	it.each([
		'what benefits am I entitled to after separation',
		'how do I kill time between my TAP appointments',
		'when does my terminal leave end',
		'I want to live near base after I separate',
		"I can't finish all this separation paperwork",
		'how do I file a disability claim'
	])('does not fire on a benign or adjacent message: %s', (q) => {
		expect(detectCrisisIntent(q).crisis).toBe(false);
	});
});
