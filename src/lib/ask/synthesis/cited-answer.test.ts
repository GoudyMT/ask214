import { describe, it, expect } from 'vitest';
import { toCitedAnswer, DISCLAIMER, type Citation } from './cited-answer';

const RETRIEVED: Citation[] = [
	{ id: 'a', url: 'https://www.va.gov/a', title: 'VA A' },
	{ id: 'b', url: 'https://www.va.gov/b', title: 'VA B' },
	{ id: 'c', url: 'https://www.va.gov/c', title: 'VA C' }
];

describe('toCitedAnswer', () => {
	it('includes only retrieved chunks the model cited, in order', () => {
		const ans = toCitedAnswer('Answer [a] and [c].', ['a', 'c'], RETRIEVED);
		expect(ans.citations.map((x) => x.id)).toEqual(['a', 'c']);
		expect(ans.citations[0]).toEqual({ id: 'a', url: 'https://www.va.gov/a', title: 'VA A' });
	});

	it('never turns a URL or phone the model wrote into a citation (anti-phishing)', () => {
		const text = 'Call 800-555-1212 or visit http://scam.example to claim, also @scammer.';
		const ans = toCitedAnswer(text, ['a'], RETRIEVED);
		// Citations come ONLY from the retrieved set, never from parsing the prose.
		expect(ans.citations.every((c) => c.url.startsWith('https://www.va.gov/'))).toBe(true);
		expect(ans.citations.map((c) => c.id)).toEqual(['a']);
	});

	it('flags link-like tokens in the prose as inert for the renderer', () => {
		const text = 'See http://scam.example, call 800-555-1212, ping @handle.';
		const ans = toCitedAnswer(text, [], RETRIEVED);
		expect(ans.inert).toContain('http://scam.example');
		expect(ans.inert.some((t) => t.includes('800-555-1212'))).toBe(true);
		expect(ans.inert.some((t) => t.includes('@handle'))).toBe(true);
	});

	it('ignores a cited id that was not retrieved (fabricates no citation)', () => {
		const ans = toCitedAnswer('[z]', ['z'], RETRIEVED);
		expect(ans.citations).toEqual([]);
	});

	it('always carries the disclaimer and preserves the text', () => {
		const ans = toCitedAnswer('the answer', [], RETRIEVED);
		expect(ans.disclaimer).toBe(DISCLAIMER);
		expect(ans.text).toBe('the answer');
	});
});
