import { describe, expect, it } from 'vitest';
import { BACKUP_CODES } from '../codes';
import { isWorkerAnswer, isWorkerRequest } from './protocol';

async function aesKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
}

const SIX = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];

describe('isWorkerAnswer: the four exact shapes', () => {
	it('accepts a words answer of six plain words', () => {
		expect(isWorkerAnswer({ type: 'words', words: SIX })).toBe(true);
	});

	it.each([1, 2, 3, 4, 5, 6])('accepts an error with position %i', (position) => {
		expect(isWorkerAnswer({ type: 'error', code: 'E_NOT_A_WORD', position })).toBe(true);
	});

	it.each(BACKUP_CODES)('accepts the error code %s without a position', (code) => {
		expect(isWorkerAnswer({ type: 'error', code })).toBe(true);
	});

	it.each([0, 1, 50, 100])('accepts progress %i', (percent) => {
		expect(isWorkerAnswer({ type: 'progress', percent })).toBe(true);
	});

	it('accepts a key answer holding a CryptoKey', async () => {
		expect(isWorkerAnswer({ type: 'key', key: await aesKey() })).toBe(true);
	});
});

describe('isWorkerAnswer: refusals', () => {
	it.each([
		['null', null],
		['undefined', undefined],
		['a string', 'words'],
		['an array', []],
		['an empty object', {}],
		['an unknown type', { type: 'done' }],
		['words with an extra key', { type: 'words', words: SIX, extra: 1 }],
		['words missing words', { type: 'words' }],
		['five words', { type: 'words', words: SIX.slice(0, 5) }],
		['seven words', { type: 'words', words: [...SIX, 'golf'] }],
		['a capital in a word', { type: 'words', words: ['Alpha', ...SIX.slice(1)] }],
		['a number as a word', { type: 'words', words: [1, ...SIX.slice(1)] }],
		['an empty word', { type: 'words', words: ['', ...SIX.slice(1)] }],
		['an error with an unknown code', { type: 'error', code: 'E_SOMETHING_ELSE' }],
		['an error with a non-string code', { type: 'error', code: 5 }],
		['an error with an extra key', { type: 'error', code: 'E_DAMAGED', detail: 'x' }],
		['an error with position 7', { type: 'error', code: 'E_NOT_A_WORD', position: 7 }],
		['an error with position 0', { type: 'error', code: 'E_NOT_A_WORD', position: 0 }],
		['an error with position 1.5', { type: 'error', code: 'E_NOT_A_WORD', position: 1.5 }],
		['an error with a string position', { type: 'error', code: 'E_NOT_A_WORD', position: '3' }],
		[
			'an error with an undefined position',
			{ type: 'error', code: 'E_NOT_A_WORD', position: undefined }
		],
		['an error missing its code', { type: 'error' }],
		['progress 101', { type: 'progress', percent: 101 }],
		['progress -1', { type: 'progress', percent: -1 }],
		['progress 2.5', { type: 'progress', percent: 2.5 }],
		['progress NaN', { type: 'progress', percent: NaN }],
		['progress as a string', { type: 'progress', percent: '5' }],
		['progress with an extra key', { type: 'progress', percent: 5, extra: 1 }],
		['a key that is not a CryptoKey', { type: 'key', key: {} }],
		['a key that is raw bytes', { type: 'key', key: new Uint8Array(32) }],
		['a key answer missing its key', { type: 'key' }]
	])('refuses %s', (_name, value) => {
		expect(isWorkerAnswer(value)).toBe(false);
	});

	it('refuses a key answer with an extra key', async () => {
		expect(isWorkerAnswer({ type: 'key', key: await aesKey(), text: 'x' })).toBe(false);
	});
});

describe('isWorkerRequest and isWorkerAnswer do not accept each other', () => {
	it('a request is not an answer and an answer is not a request', () => {
		expect(isWorkerAnswer({ op: 'generate' })).toBe(false);
		expect(isWorkerRequest({ type: 'words', words: SIX })).toBe(false);
	});
});
