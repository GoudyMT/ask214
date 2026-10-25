import { describe, expect, it } from 'vitest';
import { isWorkerAnswer, isWorkerRequest } from './protocol';

async function aesKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
}

const SIX = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];

describe('isWorkerAnswer: the four exact shapes', () => {
	it('accepts a words answer of six plain words', () => {
		expect(isWorkerAnswer({ type: 'words', words: SIX })).toBe(true);
	});

	it.each([1, 6])('accepts an error with position %i', (position) => {
		expect(isWorkerAnswer({ type: 'error', code: 'E_NOT_A_WORD', position })).toBe(true);
	});

	it('accepts an error code without a position', () => {
		expect(isWorkerAnswer({ type: 'error', code: 'E_DAMAGED' })).toBe(true);
	});

	it.each([0, 100])('accepts progress %i', (percent) => {
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

function pinBuffer(text: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(text);
	const buffer = new ArrayBuffer(bytes.length);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

const PIN_SALT = (): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: 16 }, (_, i) => i);

describe('isWorkerRequest: the derive-pin shape', () => {
	it.each(['1234', '12345', '135790', '0000'])('accepts the PIN %s with a 16-byte salt', (pin) => {
		expect(isWorkerRequest({ op: 'derive-pin', pin: pinBuffer(pin), salt: PIN_SALT() })).toBe(true);
	});

	// Each refusal is a request the page should never send; the worker must turn it away before any Argon2id.
	it.each([
		['a 3-digit PIN', { pin: pinBuffer('123') }],
		['a 7-digit PIN', { pin: pinBuffer('1234567') }],
		['an empty PIN', { pin: pinBuffer('') }],
		['a letter in the PIN', { pin: pinBuffer('12a4') }],
		['a space in the PIN', { pin: pinBuffer('12 4') }],
		['a full-width digit', { pin: pinBuffer(String.fromCharCode(0xff11) + '234') }],
		['a PIN that is a view, not a buffer', { pin: new Uint8Array(pinBuffer('1234')) }],
		['a PIN that is text', { pin: '1234' }],
		['a salt of 15 bytes', { pin: pinBuffer('1234'), salt: new Uint8Array(15) }],
		['a salt of 17 bytes', { pin: pinBuffer('1234'), salt: new Uint8Array(17) }],
		['a salt that is text', { pin: pinBuffer('1234'), salt: 'x'.repeat(16) }],
		['an extra key', { pin: pinBuffer('1234'), extra: 1 }],
		['a purpose key', { pin: pinBuffer('1234'), purpose: 'restore' }],
		['a pass instead of a pin', { pin: undefined, pass: pinBuffer('1234') }]
	])('refuses %s', (_name, override) => {
		const base: Record<string, unknown> = {
			op: 'derive-pin',
			pin: pinBuffer('1234'),
			salt: PIN_SALT()
		};
		const request: Record<string, unknown> = { ...base, ...override };
		if (request.pin === undefined) delete request.pin;
		expect(isWorkerRequest(request)).toBe(false);
	});

	it('refuses a derive-pin request missing its salt', () => {
		expect(isWorkerRequest({ op: 'derive-pin', pin: pinBuffer('1234') })).toBe(false);
	});
});

describe('isWorkerAnswer: the pin-keys shape', () => {
	async function macKey(): Promise<CryptoKey> {
		return crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
	}
	async function kek(): Promise<CryptoKey> {
		return crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, [
			'wrapKey',
			'unwrapKey'
		]);
	}

	it('accepts two CryptoKeys under exactly kek, macKey and type', async () => {
		expect(isWorkerAnswer({ type: 'pin-keys', macKey: await macKey(), kek: await kek() })).toBe(
			true
		);
	});

	it('refuses a missing key, a key that is not a CryptoKey and an extra key', async () => {
		expect(isWorkerAnswer({ type: 'pin-keys', macKey: await macKey() })).toBe(false);
		expect(isWorkerAnswer({ type: 'pin-keys', macKey: {}, kek: await kek() })).toBe(false);
		expect(
			isWorkerAnswer({ type: 'pin-keys', macKey: await macKey(), kek: new Uint8Array(32) })
		).toBe(false);
		expect(
			isWorkerAnswer({ type: 'pin-keys', macKey: await macKey(), kek: await kek(), text: 'x' })
		).toBe(false);
	});
});

describe('isWorkerRequest and isWorkerAnswer do not accept each other', () => {
	it('a request is not an answer and an answer is not a request', () => {
		expect(isWorkerAnswer({ op: 'generate' })).toBe(false);
		expect(isWorkerRequest({ type: 'words', words: SIX })).toBe(false);
	});
});
