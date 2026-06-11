import { describe, it, expect } from 'vitest';
import { CorpusFormatError, CorpusVersionError } from './errors';

// Typed corpus failures (mirrors the timeline codec's error classes): structural problems with a
// shipped corpus artifact, never PII. Carry a name for instanceof-free discrimination + a message.

describe('corpus errors', () => {
	it('CorpusFormatError is an Error with its own name + message', () => {
		const e = new CorpusFormatError('bad bytes');
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe('CorpusFormatError');
		expect(e.message).toBe('bad bytes');
	});

	it('CorpusVersionError is an Error with its own name + message', () => {
		const e = new CorpusVersionError('old corpus');
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe('CorpusVersionError');
		expect(e.message).toBe('old corpus');
	});
});
