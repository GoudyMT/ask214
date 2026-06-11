/**
 * Typed failures decoding a shipped corpus artifact. Structural only (never PII): a bad/corrupt
 * blob, a model mismatch, a zero embedding. Mirrors the timeline codec's error pattern.
 */

export class CorpusFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CorpusFormatError';
	}
}

/** The shipped corpus generation is not one this client build supports (spec section 8.6). */
export class CorpusVersionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CorpusVersionError';
	}
}
