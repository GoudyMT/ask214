import { describe, it, expect } from 'vitest';
import { AskError, ASK_ERROR } from './errors';

describe('ask errors', () => {
	it('AskError is an Error carrying a static opaque code', () => {
		const e = new AskError(ASK_ERROR.EMBED);
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe('AskError');
		expect(e.code).toBe('E_ASK_EMBED');
		expect(e.message).toBe('E_ASK_EMBED');
	});

	it('exposes the model-load + corpus codes', () => {
		expect(ASK_ERROR.MODEL_LOAD).toBe('E_ASK_MODEL_LOAD');
		expect(ASK_ERROR.CORPUS).toBe('E_ASK_CORPUS');
	});
});
