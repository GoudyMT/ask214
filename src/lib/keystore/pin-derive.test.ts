import { afterEach, describe, expect, it, vi } from 'vitest';
import { KDF_V1 } from '../backup/kdf-params';
import type { FromWorker, PinRequest } from '../backup/worker/protocol';
import { PinNoMemoryError, derivePinKeys, isPinFormat, type PinWorkerLike } from './pin-derive';
import { KeystoreHmacMismatchError } from './read';

afterEach(() => {
	vi.useRealTimers();
});

const SALT = (): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: 16 }, (_, i) => i);
const PARAMS = () => ({ kdf: { ...KDF_V1 }, salt: SALT() });

async function macKey(
	options: { extractable?: boolean; usages?: KeyUsage[]; hash?: string } = {}
): Promise<CryptoKey> {
	return crypto.subtle.generateKey(
		{ name: 'HMAC', hash: options.hash ?? 'SHA-256', length: 256 },
		options.extractable ?? false,
		options.usages ?? ['sign', 'verify']
	);
}

async function kek(
	options: { extractable?: boolean; usages?: KeyUsage[]; length?: number } = {}
): Promise<CryptoKey> {
	return crypto.subtle.generateKey(
		{ name: 'AES-KW', length: options.length ?? 256 },
		options.extractable ?? false,
		options.usages ?? ['wrapKey', 'unwrapKey']
	);
}

type Posted = { message: PinRequest; transfer: Transferable[] | undefined };
type Answer = (data: unknown) => void;

/** A worker that records what the page posts and lets the test answer, fail or stay silent. */
function fakeWorker(react: (answer: Answer, fail: () => void, posted: Posted) => void) {
	const posted: Posted[] = [];
	const terminate = vi.fn();
	const worker: PinWorkerLike = {
		postMessage: (message, transfer) => {
			const entry = { message, transfer };
			posted.push(entry);
			queueMicrotask(() =>
				react(
					(data) => worker.onmessage?.({ data }),
					() => worker.onerror?.(new Event('error')),
					entry
				)
			);
		},
		terminate,
		onmessage: null,
		onerror: null,
		onmessageerror: null
	};
	const createWorker = vi.fn(() => worker);
	return { worker, posted, terminate, createWorker };
}

// For the tests that must start no worker: if a check were skipped the derive would run and end here, so the test fails
// on its assertion at once instead of waiting out the deadline.
const answersNoMemory = (reply: Answer): void => reply({ type: 'error', code: 'E_NO_MEMORY' });

async function goodAnswer(): Promise<FromWorker> {
	return { type: 'pin-keys', macKey: await macKey(), kek: await kek() };
}

describe('isPinFormat', () => {
	it.each([
		['4 digits', '1234', true],
		['6 digits', '135790', true],
		['leading zeros', '000000', true],
		['3 digits', '123', false],
		['7 digits', '1234567', false],
		['empty', '', false],
		['a letter', '12a4', false],
		['a space', '12 4', false],
		['a trailing newline', '1234' + String.fromCharCode(10), false],
		['a full-width digit', String.fromCharCode(0xff11) + '234', false],
		['an Arabic-Indic digit', String.fromCharCode(0x0661) + '234', false]
	])('%s', (_name, pin, expected) => {
		expect(isPinFormat(pin)).toBe(expected);
	});
});

describe('derivePinKeys: the stored numbers are checked before any worker', () => {
	// Numbers that are not the backup's tuple mean the stored record is damaged. That is never the person's wrong try.
	it.each([
		['v', { v: KDF_V1.v + 1 }],
		['m', { m: KDF_V1.m - 1 }],
		['t', { t: KDF_V1.t + 1 }],
		['p', { p: KDF_V1.p + 1 }],
		['dkLen', { dkLen: KDF_V1.dkLen + 1 }]
	])(
		'a %s that is off throws the damaged-record error and starts no worker',
		async (_n, change) => {
			const { createWorker } = fakeWorker(answersNoMemory);
			await expect(
				derivePinKeys('1234', { kdf: { ...KDF_V1, ...change }, salt: SALT() }, { createWorker })
			).rejects.toBeInstanceOf(KeystoreHmacMismatchError);
			expect(createWorker).not.toHaveBeenCalled();
		}
	);

	it.each([15, 17, 0])(
		'a salt of %i bytes throws the damaged-record error and starts no worker',
		async (n) => {
			const { createWorker } = fakeWorker(answersNoMemory);
			await expect(
				derivePinKeys('1234', { kdf: { ...KDF_V1 }, salt: new Uint8Array(n) }, { createWorker })
			).rejects.toBeInstanceOf(KeystoreHmacMismatchError);
			expect(createWorker).not.toHaveBeenCalled();
		}
	);

	it('a PIN of the wrong shape throws E_PIN_FORMAT and starts no worker, after the tuple check', async () => {
		const { createWorker } = fakeWorker(answersNoMemory);
		await expect(derivePinKeys('12a4', PARAMS(), { createWorker })).rejects.toThrow('E_PIN_FORMAT');
		await expect(
			derivePinKeys('12a4', { kdf: { ...KDF_V1, t: 1 }, salt: SALT() }, { createWorker })
		).rejects.toBeInstanceOf(KeystoreHmacMismatchError);
		expect(createWorker).not.toHaveBeenCalled();
	});
});

describe('derivePinKeys: the worker conversation', () => {
	it('posts exactly op, pin and salt with the PIN transferred, forwards progress, returns the keys', async () => {
		const answer = await goodAnswer();
		let pinBytes: number[] = [];
		const { createWorker, posted, terminate } = fakeWorker((reply, _fail, entry) => {
			// Read before the client zeroes the buffer. The fake does not detach it as a real transfer does.
			pinBytes = [...new Uint8Array(entry.message.pin)];
			reply({ type: 'progress', percent: 40 });
			reply(answer);
		});
		const onProgress = vi.fn();
		const keys = await derivePinKeys('135790', PARAMS(), { createWorker, onProgress });
		expect(keys.macKey).toBe((answer as { macKey: CryptoKey }).macKey);
		expect(keys.kek).toBe((answer as { kek: CryptoKey }).kek);
		expect(onProgress).toHaveBeenCalledExactlyOnceWith(40);
		const [entry] = posted;
		if (entry === undefined) throw new Error('nothing was posted');
		expect(entry.message.op).toBe('derive-pin');
		// The ASCII digits of '135790', in the order typed: the lock key is only right if the worker gets these bytes.
		expect(pinBytes).toEqual([0x31, 0x33, 0x35, 0x37, 0x39, 0x30]);
		expect(Object.keys(entry.message).sort()).toEqual(['op', 'pin', 'salt']);
		expect(entry.transfer).toEqual([entry.message.pin]);
		expect(entry.message.salt).toEqual(SALT());
		expect(terminate).toHaveBeenCalledOnce();
	});

	it('the PIN bytes the page held are zeroed once the answer is in', async () => {
		let sent: ArrayBuffer | undefined;
		const answer = await goodAnswer();
		const { createWorker } = fakeWorker((reply, _fail, posted) => {
			sent = posted.message.pin;
			reply(answer);
		});
		await derivePinKeys('135790', PARAMS(), { createWorker });
		expect(sent).toBeDefined();
		// A real transfer detaches the buffer; the fake does not, so what is left must be zero.
		expect(new Uint8Array(sent ?? new ArrayBuffer(0)).every((byte) => byte === 0)).toBe(true);
	});

	it('NO_MEMORY from the worker becomes PinNoMemoryError, and the worker is stopped', async () => {
		const { createWorker, terminate } = fakeWorker((reply) =>
			reply({ type: 'error', code: 'E_NO_MEMORY' })
		);
		const error: unknown = await derivePinKeys('1234', PARAMS(), { createWorker }).catch((e) => e);
		expect(error).toBeInstanceOf(PinNoMemoryError);
		expect(error).toMatchObject({ name: 'PinNoMemoryError', message: 'E_NO_MEMORY' });
		expect(terminate).toHaveBeenCalledOnce();
	});

	it.each([
		[
			'another worker error code',
			(reply: Answer) => reply({ type: 'error', code: 'E_CRYPTO_FAILED' })
		],
		['a worker error event', (_reply: Answer, fail: () => void) => fail()],
		['an answer of the wrong shape', (reply: Answer) => reply({ type: 'pin-keys', macKey: {} })],
		['a backup key answer', async (reply: Answer) => reply({ type: 'key', key: await macKey() })],
		['a stray string', (reply: Answer) => reply('done')]
	])('%s is E_WORKER_FAILED, and the worker is stopped', async (_n, react) => {
		const { createWorker, terminate } = fakeWorker((reply, fail) => void react(reply, fail));
		await expect(derivePinKeys('1234', PARAMS(), { createWorker })).rejects.toThrow(
			'E_WORKER_FAILED'
		);
		expect(terminate).toHaveBeenCalledOnce();
	});

	// A browser that cannot start the worker (a blocked script, no memory for a thread) must end as the worker code,
	// with the PIN bytes wiped; a raw TypeError would escape the lock screen's handling.
	it('a worker that fails to start is E_WORKER_FAILED, and the PIN bytes are zeroed', async () => {
		// The PIN buffer is made inside the call, so the test collects every buffer made while it runs.
		const made: ArrayBuffer[] = [];
		vi.stubGlobal(
			'ArrayBuffer',
			class extends ArrayBuffer {
				constructor(length: number) {
					super(length);
					made.push(this);
				}
			}
		);
		try {
			const createWorker = vi.fn((): PinWorkerLike => {
				throw new TypeError('x');
			});
			await expect(derivePinKeys('135790', PARAMS(), { createWorker })).rejects.toThrow(
				'E_WORKER_FAILED'
			);
			expect(createWorker).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
		}
		const pinBuffers = made.filter((buffer) => buffer.byteLength === 6);
		expect(pinBuffers).toHaveLength(1);
		expect(new Uint8Array(pinBuffers[0] ?? new ArrayBuffer(0)).every((byte) => byte === 0)).toBe(
			true
		);
	});

	it('a post that throws is E_WORKER_FAILED, the PIN bytes are zeroed and the worker is stopped', async () => {
		let sent: ArrayBuffer | undefined;
		const { worker, terminate, createWorker } = fakeWorker(() => undefined);
		worker.postMessage = (message) => {
			sent = message.pin;
			throw new Error('DataCloneError');
		};
		await expect(derivePinKeys('135790', PARAMS(), { createWorker })).rejects.toThrow(
			'E_WORKER_FAILED'
		);
		expect(new Uint8Array(sent ?? new ArrayBuffer(0)).every((byte) => byte === 0)).toBe(true);
		expect(sent?.byteLength).toBe(6);
		expect(terminate).toHaveBeenCalledOnce();
	});

	// A worker that never answers (a killed tab, a stuck derive) must end in an error, never a spinner.
	it('gives up with E_WORKER_FAILED at 60 s and stops the worker', async () => {
		vi.useFakeTimers();
		const { createWorker, terminate } = fakeWorker(() => undefined);
		const outcome = derivePinKeys('1234', PARAMS(), { createWorker }).then(
			() => 'resolved',
			(error: unknown) => error
		);
		await vi.advanceTimersByTimeAsync(59_999);
		expect(terminate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(await outcome).toMatchObject({ message: 'E_WORKER_FAILED' });
		expect(terminate).toHaveBeenCalledOnce();
	});

	it('does not time out an answered derive afterwards', async () => {
		vi.useFakeTimers();
		const answer = await goodAnswer();
		const { createWorker } = fakeWorker((reply) => reply(answer));
		await derivePinKeys('1234', PARAMS(), { createWorker });
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('derivePinKeys: the keys are checked as they arrive', () => {
	// The worker is another thread; a key that is extractable or made for another job must never be used for a lock.
	it.each([
		[
			'an extractable MAC key',
			async () => ({ macKey: await macKey({ extractable: true }), kek: await kek() })
		],
		[
			'an extractable KEK',
			async () => ({ macKey: await macKey(), kek: await kek({ extractable: true }) })
		],
		[
			'a MAC key that can only sign',
			async () => ({ macKey: await macKey({ usages: ['sign'] }), kek: await kek() })
		],
		[
			'a KEK that can only wrap',
			async () => ({ macKey: await macKey(), kek: await kek({ usages: ['wrapKey'] }) })
		],
		[
			'a MAC key with SHA-512',
			async () => ({ macKey: await macKey({ hash: 'SHA-512' }), kek: await kek() })
		],
		['a 128-bit KEK', async () => ({ macKey: await macKey(), kek: await kek({ length: 128 }) })],
		['the two keys swapped', async () => ({ macKey: await kek(), kek: await macKey() })]
	])('%s is E_KEY_SHAPE, and the worker is stopped', async (_n, keys) => {
		const { macKey: m, kek: k } = await keys();
		const { createWorker, terminate } = fakeWorker((reply) =>
			reply({ type: 'pin-keys', macKey: m, kek: k })
		);
		await expect(derivePinKeys('1234', PARAMS(), { createWorker })).rejects.toThrow('E_KEY_SHAPE');
		expect(terminate).toHaveBeenCalledOnce();
	});
});
