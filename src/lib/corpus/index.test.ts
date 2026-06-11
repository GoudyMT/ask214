import { describe, it, expect } from 'vitest';
import * as corpus from './index';

// Smoke-test the public surface so an export typo fails CI rather than the first consumer (cycle C).
describe('corpus barrel', () => {
	it('re-exports the public functions', () => {
		expect(typeof corpus.decodeCorpus).toBe('function');
		expect(typeof corpus.search).toBe('function');
		expect(typeof corpus.toResultCards).toBe('function');
		expect(corpus.ACCEPTED_CORPUS_VERSION).toBe('1.0');
		expect(typeof corpus.CorpusFormatError).toBe('function');
	});
});
