import { describe, it, expect } from 'vitest';
import {
	bumpIvCounter,
	IV_WARN_THRESHOLD,
	IV_HARD_STOP,
	IvCounterExhaustedError
} from './iv-counter';

describe('bumpIvCounter', () => {
	it('returns newValue = prev + 1 with warn=false below warn threshold', () => {
		const r = bumpIvCounter(0);
		expect(r.newValue).toBe(1);
		expect(r.warn).toBe(false);
		expect(r.halt).toBe(false);
	});

	it('sets warn=true when crossing warn threshold', () => {
		const r = bumpIvCounter(IV_WARN_THRESHOLD - 1);
		expect(r.newValue).toBe(IV_WARN_THRESHOLD);
		expect(r.warn).toBe(true);
		expect(r.halt).toBe(false);
	});

	it('keeps warn=true past threshold (no de-bounce)', () => {
		const r = bumpIvCounter(IV_WARN_THRESHOLD + 100);
		expect(r.warn).toBe(true);
		expect(r.halt).toBe(false);
	});

	it('throws IvCounterExhaustedError at hard-stop', () => {
		expect(() => bumpIvCounter(IV_HARD_STOP)).toThrow(IvCounterExhaustedError);
	});

	it('throws IvCounterExhaustedError past hard-stop', () => {
		expect(() => bumpIvCounter(IV_HARD_STOP + 1)).toThrow(IvCounterExhaustedError);
	});

	it('hard-stop threshold equals 2^32 - 2^24', () => {
		expect(IV_HARD_STOP).toBe(2 ** 32 - 2 ** 24);
	});

	it('warn threshold equals 2^28', () => {
		expect(IV_WARN_THRESHOLD).toBe(2 ** 28);
	});
});
