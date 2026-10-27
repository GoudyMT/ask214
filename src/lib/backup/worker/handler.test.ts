import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HKDF_INFO_V1, KDF_V1 } from '../kdf-params';
import {
	KAT_PIN,
	KAT_PIN_MAC_MESSAGE,
	KAT_PIN_SMALL,
	KAT_PIN_WRAPPED_KEY,
	KAT_SALT
} from '../kdf-kat';
import { WORDS_V1 } from '../words-v1';
import { createHandler } from './handler';
import type { FromWorker } from './protocol';

type ArgonOptions = { onProgress?: (p: number) => void } & Record<string, unknown>;

const mocks = vi.hoisted(() => ({ argon2id: vi.fn(), argon2idAsync: vi.fn() }));
vi.mock('@noble/hashes/argon2.js', () => ({
	argon2id: mocks.argon2id,
	argon2idAsync: mocks.argon2idAsync
}));

const MAXMEM = 134217728;
const FAKE_OUTPUT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

function wordAt(index: number): string {
	const word = WORDS_V1[index];
	if (word === undefined) throw new Error('index outside the list');
	return word;
}

const PHRASE = [10, 200, 3000, 4000, 5000, 7000].map(wordAt);
const PHRASE_TEXT = PHRASE.join(' ');
const NOT_A_WORD = 'qqqzzqq';

function bufferOf(text: string): ArrayBuffer {
	const bytes = new TextEncoder().encode(text);
	const buffer = new ArrayBuffer(bytes.length);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function saltOf(length = 16): Uint8Array<ArrayBuffer> {
	return Uint8Array.from({ length }, (_, i) => 100 + i);
}

function isZero(buffer: ArrayBuffer): boolean {
	return new Uint8Array(buffer).every((byte) => byte === 0);
}

type Run = { posts: FromWorker[]; pass: ArrayBuffer };

async function runDerive(
	text: string,
	purpose: 'export' | 'restore' = 'restore',
	salt: Uint8Array<ArrayBuffer> = saltOf()
): Promise<Run> {
	const posts: FromWorker[] = [];
	const pass = bufferOf(text);
	const { handle } = createHandler(WORDS_V1, (msg) => posts.push(msg));
	await handle({ op: 'derive', purpose, pass, salt });
	return { posts, pass };
}

function swapWord(position: number, replacement: string): string {
	return PHRASE.map((word, i) => (i === position - 1 ? replacement : word)).join(' ');
}

function argonCalls(): number {
	return mocks.argon2id.mock.calls.length + mocks.argon2idAsync.mock.calls.length;
}

function fakeArgon(_pass: Uint8Array, _salt: Uint8Array, opts: ArgonOptions): Uint8Array {
	opts.onProgress?.(0.5);
	opts.onProgress?.(1);
	return Uint8Array.from(FAKE_OUTPUT);
}

beforeEach(() => {
	mocks.argon2id.mockReset();
	mocks.argon2idAsync.mockReset();
	mocks.argon2id.mockImplementation(fakeArgon);
});

describe('derive: the word check comes first', () => {
	it.each([1, 6])(
		'an unknown word at position %i posts NOT_A_WORD with its position and never calls argon2id',
		async (position) => {
			const { posts } = await runDerive(swapWord(position, NOT_A_WORD));
			expect(posts).toEqual([{ type: 'error', code: 'E_NOT_A_WORD', position }]);
			expect(mocks.argon2id).not.toHaveBeenCalled();
			expect(mocks.argon2idAsync).not.toHaveBeenCalled();
		}
	);

	it('reports the first unknown word when several are unknown', async () => {
		const text = swapWord(5, NOT_A_WORD).replace(PHRASE[2] ?? '', 'zzzyyy');
		const { posts } = await runDerive(text);
		expect(posts).toEqual([{ type: 'error', code: 'E_NOT_A_WORD', position: 3 }]);
	});

	it('non-canonical bytes (a double space) post WORKER_FAILED and argon2id is never called', async () => {
		const { posts, pass } = await runDerive(`${PHRASE[0]}  ${PHRASE.slice(1).join(' ')}`);
		expect(posts).toEqual([{ type: 'error', code: 'E_WORKER_FAILED' }]);
		expect(argonCalls()).toBe(0);
		expect(isZero(pass)).toBe(true);
	});
});

describe('derive: the passphrase bytes are wiped on every path', () => {
	it('the passphrase bytes are zeroed on NOT_A_WORD', async () => {
		const { pass } = await runDerive(swapWord(2, NOT_A_WORD));
		expect(pass.byteLength).toBeGreaterThan(0);
		expect(isZero(pass)).toBe(true);
	});

	it('the passphrase bytes are zeroed on success', async () => {
		const { posts, pass } = await runDerive(PHRASE_TEXT);
		expect(posts.at(-1)?.type).toBe('key');
		expect(isZero(pass)).toBe(true);
	});

	it('the passphrase bytes are zeroed when argon2id throws', async () => {
		mocks.argon2id.mockImplementation(() => {
			throw new Error('boom');
		});
		const { pass } = await runDerive(PHRASE_TEXT);
		expect(isZero(pass)).toBe(true);
	});

	it('the passphrase bytes are zeroed when the key step fails', async () => {
		let output: Uint8Array | undefined;
		mocks.argon2id.mockImplementation(() => {
			output = Uint8Array.from(FAKE_OUTPUT);
			return output;
		});
		const import_ = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new Error('no'));
		try {
			const { pass, posts } = await runDerive(PHRASE_TEXT);
			expect(posts.at(-1)).toEqual({ type: 'error', code: 'E_CRYPTO_FAILED' });
			expect(posts.some((msg) => msg.type === 'key')).toBe(false);
			expect(isZero(pass)).toBe(true);
			expect(output).toBeDefined();
			expect(output?.every((byte) => byte === 0)).toBe(true);
		} finally {
			import_.mockRestore();
		}
	});

	it('the Argon2id output is zeroed after the key is made', async () => {
		let output: Uint8Array | undefined;
		mocks.argon2id.mockImplementation(() => {
			output = Uint8Array.from(FAKE_OUTPUT);
			return output;
		});
		await runDerive(PHRASE_TEXT);
		expect(output?.every((byte) => byte === 0)).toBe(true);
	});

	it('a throw while posting the key still ends in WORKER_FAILED and zeroed bytes', async () => {
		const posts: FromWorker[] = [];
		const pass = bufferOf(PHRASE_TEXT);
		const { handle } = createHandler(WORDS_V1, (msg) => {
			if (msg.type === 'key') throw new Error('cannot clone');
			posts.push(msg);
		});
		await expect(handle({ op: 'derive', purpose: 'restore', pass, salt: saltOf() })).resolves.toBe(
			undefined
		);
		expect(posts.at(-1)).toEqual({ type: 'error', code: 'E_WORKER_FAILED' });
		expect(isZero(pass)).toBe(true);
	});
});

describe('derive: the Argon2id call', () => {
	it('argon2id is called with exactly t, m, p, version, dkLen, maxmem, onProgress', async () => {
		let passAtCall: number[] = [];
		mocks.argon2id.mockImplementation((pass: Uint8Array) => {
			passAtCall = [...pass];
			return Uint8Array.from(FAKE_OUTPUT);
		});
		const salt = saltOf();
		await runDerive(PHRASE_TEXT, 'restore', salt);
		expect(mocks.argon2id).toHaveBeenCalledTimes(1);
		const [pass, calledSalt, opts] = mocks.argon2id.mock.calls[0] as [
			Uint8Array,
			Uint8Array,
			ArgonOptions
		];
		expect(Object.keys(opts).sort()).toEqual(
			['dkLen', 'm', 'maxmem', 'onProgress', 'p', 't', 'version'].sort()
		);
		expect(opts).toMatchObject({
			t: KDF_V1.t,
			m: KDF_V1.m,
			p: KDF_V1.p,
			version: KDF_V1.v,
			dkLen: KDF_V1.dkLen,
			maxmem: MAXMEM
		});
		expect(typeof opts.onProgress).toBe('function');
		expect(passAtCall).toEqual([...new TextEncoder().encode(PHRASE_TEXT)]);
		expect(pass).toBeInstanceOf(Uint8Array);
		expect([...calledSalt]).toEqual([...salt]);
	});

	it('progress posts only when the percent changes', async () => {
		mocks.argon2id.mockImplementation((_p: Uint8Array, _s: Uint8Array, opts: ArgonOptions) => {
			for (let i = 0; i < 10_000; i++) opts.onProgress?.(i / 10_000);
			opts.onProgress?.(1);
			return Uint8Array.from(FAKE_OUTPUT);
		});
		const { posts } = await runDerive(PHRASE_TEXT);
		const percents = posts.flatMap((msg) => (msg.type === 'progress' ? [msg.percent] : []));
		expect(percents.length).toBeLessThanOrEqual(101);
		expect(percents.length).toBe(101);
		percents.forEach((percent, i) => {
			if (i > 0) expect(percent).toBeGreaterThan(percents[i - 1] ?? Infinity);
		});
		expect(percents[0]).toBe(0);
		expect(percents.at(-1)).toBe(100);
	});

	it("a RangeError from the worker's argon2id maps to NO_MEMORY", async () => {
		mocks.argon2id.mockImplementation(() => {
			throw new RangeError('Array buffer allocation failed');
		});
		const { posts } = await runDerive(PHRASE_TEXT);
		expect(posts).toEqual([{ type: 'error', code: 'E_NO_MEMORY' }]);
	});

	it('any other throw maps to WORKER_FAILED', async () => {
		mocks.argon2id.mockImplementation(() => {
			throw new Error('maxmem limit was hit');
		});
		const { posts } = await runDerive(PHRASE_TEXT);
		expect(posts).toEqual([{ type: 'error', code: 'E_WORKER_FAILED' }]);
	});
});

async function referenceKey(
	output: Uint8Array<ArrayBuffer>,
	salt: Uint8Array<ArrayBuffer>,
	info: string
): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey('raw', output, 'HKDF', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

// A wrong key makes AES-GCM throw; turning that into null lets the test fail on a comparison, not on a crash.
async function openOrNull(
	key: CryptoKey,
	iv: Uint8Array<ArrayBuffer>,
	sealed: ArrayBuffer
): Promise<number[] | null> {
	try {
		return [...new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed))];
	} catch {
		return null;
	}
}

function keyOf(posts: FromWorker[]): CryptoKey {
	const last = posts.at(-1);
	if (last?.type !== 'key') throw new Error('no key was posted');
	return last.key;
}

describe('derive: the key', () => {
	it('the restore key is non-extractable with usages exactly decrypt', async () => {
		const key = keyOf((await runDerive(PHRASE_TEXT, 'restore')).posts);
		expect(key.extractable).toBe(false);
		expect(key.type).toBe('secret');
		expect([...key.usages]).toEqual(['decrypt']);
		expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
		await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
	});

	it('the export key has encrypt and decrypt and is non-extractable', async () => {
		const key = keyOf((await runDerive(PHRASE_TEXT, 'export')).posts);
		expect(key.extractable).toBe(false);
		expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt']);
		expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
	});

	it('the key is HKDF-SHA256 of the Argon2id output with the file salt and the v1 info', async () => {
		const salt = saltOf();
		const iv = new Uint8Array(12);
		const block = new Uint8Array(32).fill(7);
		const exportKey = keyOf((await runDerive(PHRASE_TEXT, 'export', salt)).posts);
		const reference = await referenceKey(
			Uint8Array.from(FAKE_OUTPUT),
			salt,
			'ask214-backup-v1/aes-gcm-256'
		);
		const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, exportKey, block);
		expect(await openOrNull(reference, iv, sealed)).toEqual([...block]);

		const restoreKey = keyOf((await runDerive(PHRASE_TEXT, 'restore', salt)).posts);
		const sealedByReference = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			reference,
			block
		);
		expect(await openOrNull(restoreKey, iv, sealedByReference)).toEqual([...block]);
	});

	it("the HKDF info is not one of the app's other key labels", () => {
		const labels: string[] = [];
		for (const folder of ['keystore', 'crypto', 'profile']) {
			const dir = new URL(`../../${folder}/`, import.meta.url);
			for (const name of readdirSync(dir)) {
				if (!name.endsWith('.ts') || name.includes('.test.')) continue;
				const source = readFileSync(new URL(name, dir), 'utf8');
				for (const match of source.matchAll(/'(mtc[^']*)'/g)) labels.push(match[1] ?? '');
			}
		}
		expect(labels).toContain('mtc-v1|keystore-record|');
		expect(labels).toContain('mtc-v1|sidecar|');
		for (const label of labels) expect(HKDF_INFO_V1.startsWith(label)).toBe(false);
		expect(HKDF_INFO_V1).toBe('ask214-backup-v1/aes-gcm-256');
	});
});

describe('generate and malformed requests', () => {
	it('generate posts six list words', async () => {
		const posts: FromWorker[] = [];
		const { handle } = createHandler(WORDS_V1, (msg) => posts.push(msg));
		await handle({ op: 'generate' });
		expect(posts).toHaveLength(1);
		const [post] = posts;
		if (post?.type !== 'words') throw new Error('not a words post');
		expect(post.words).toHaveLength(6);
		const list = new Set(WORDS_V1);
		expect(post.words.every((word) => list.has(word))).toBe(true);
		expect(argonCalls()).toBe(0);
	});

	const goodSalt = () => saltOf();
	it.each([
		['a missing op', (pass: ArrayBuffer) => ({ purpose: 'restore', pass, salt: goodSalt() })],
		[
			'an unknown op',
			(pass: ArrayBuffer) => ({ op: 'wipe', purpose: 'restore', pass, salt: goodSalt() })
		],
		[
			'a salt of 15 bytes',
			(pass: ArrayBuffer) => ({ op: 'derive', purpose: 'restore', pass, salt: saltOf(15) })
		],
		[
			'a salt of 17 bytes',
			(pass: ArrayBuffer) => ({ op: 'derive', purpose: 'restore', pass, salt: saltOf(17) })
		],
		[
			'a salt that is not bytes',
			(pass: ArrayBuffer) => ({ op: 'derive', purpose: 'restore', pass, salt: 'x'.repeat(16) })
		],
		[
			'an unknown purpose',
			(pass: ArrayBuffer) => ({ op: 'derive', purpose: 'backup', pass, salt: goodSalt() })
		],
		[
			'an extra key',
			(pass: ArrayBuffer) => ({
				op: 'derive',
				purpose: 'restore',
				pass,
				salt: goodSalt(),
				extra: 1
			})
		]
	])(
		'a malformed request (%s) posts WORKER_FAILED and zeroes the pass it carries',
		async (_name, build) => {
			const posts: FromWorker[] = [];
			const pass = bufferOf(PHRASE_TEXT);
			const { handle } = createHandler(WORDS_V1, (msg) => posts.push(msg));
			await handle(build(pass));
			expect(posts).toEqual([{ type: 'error', code: 'E_WORKER_FAILED' }]);
			expect(argonCalls()).toBe(0);
			expect(isZero(pass)).toBe(true);
		}
	);

	it.each([
		[
			'a pass that is a view',
			{ op: 'derive', purpose: 'restore', pass: new Uint8Array(4), salt: goodSalt() }
		],
		['a missing pass', { op: 'derive', purpose: 'restore', salt: goodSalt() }]
	])('a malformed request (%s) posts WORKER_FAILED', async (_name, message) => {
		const posts: FromWorker[] = [];
		const { handle } = createHandler(WORDS_V1, (msg) => posts.push(msg));
		await handle(message);
		expect(posts).toEqual([{ type: 'error', code: 'E_WORKER_FAILED' }]);
		expect(argonCalls()).toBe(0);
	});

	it.each([
		['generate with an extra key', { op: 'generate', extra: 1 }],
		['null', null],
		['a string', 'derive'],
		['undefined', undefined],
		['an array', []]
	])('a malformed request (%s) posts WORKER_FAILED', async (_name, message) => {
		const posts: FromWorker[] = [];
		const { handle } = createHandler(WORDS_V1, (msg) => posts.push(msg));
		await handle(message);
		expect(posts).toEqual([{ type: 'error', code: 'E_WORKER_FAILED' }]);
	});
});

const PIN_TEXT = KAT_PIN;

type PinKeys = { macKey: CryptoKey; kek: CryptoKey };

async function runDerivePin(
	text: string = PIN_TEXT,
	salt: Uint8Array<ArrayBuffer> = saltOf()
): Promise<Run> {
	const posts: FromWorker[] = [];
	const pass = bufferOf(text);
	const { handle } = createHandler(WORDS_V1, (msg) => posts.push(msg));
	await handle({ op: 'derive-pin', pin: pass, salt });
	return { posts, pass };
}

function pinKeysOf(posts: FromWorker[]): PinKeys {
	const last = posts.at(-1);
	if (last?.type !== 'pin-keys') throw new Error('no pin keys were posted');
	return last;
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
	return Array.from(view, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('derive-pin: a PIN of the wrong shape costs no derive', () => {
	// The page checks the PIN first, so a bad one here is a bug; it must still never cost the several seconds, and the
	// buffer the page gave away must be wiped.
	it.each([
		['a letter', '12a4'],
		['3 digits', '123'],
		['7 digits', '1234567'],
		['a space', '12 4'],
		['a full-width digit', String.fromCharCode(0xff11) + '234'],
		['an empty PIN', '']
	])(
		'%s is refused with WORKER_FAILED before argon2id, and its buffer is zeroed',
		async (_n, text) => {
			const { posts, pass } = await runDerivePin(text);
			expect(posts).toEqual([{ type: 'error', code: 'E_WORKER_FAILED' }]);
			expect(argonCalls()).toBe(0);
			expect(isZero(pass)).toBe(true);
			if (text !== '') expect(pass.byteLength).toBeGreaterThan(0);
		}
	);
});

describe('derive-pin: the keys', () => {
	it('posts one pin-keys answer with exactly kek, macKey and type, after progress', async () => {
		const { posts } = await runDerivePin();
		const last = posts.at(-1);
		expect(Object.keys(last ?? {}).sort()).toEqual(['kek', 'macKey', 'type']);
		expect(posts.slice(0, -1).every((msg) => msg.type === 'progress')).toBe(true);
		expect(posts.filter((msg) => msg.type === 'progress').length).toBeGreaterThan(0);
	});

	it('the MAC key signs and verifies only, the KEK wraps and unwraps only, neither is extractable', async () => {
		const { macKey, kek } = pinKeysOf((await runDerivePin()).posts);
		expect(macKey).toBeInstanceOf(CryptoKey);
		expect(kek).toBeInstanceOf(CryptoKey);
		expect(macKey.extractable).toBe(false);
		expect(kek.extractable).toBe(false);
		expect(macKey.algorithm).toMatchObject({
			name: 'HMAC',
			hash: { name: 'SHA-256' },
			length: 256
		});
		expect([...macKey.usages].sort()).toEqual(['sign', 'verify']);
		expect(kek.algorithm).toMatchObject({ name: 'AES-KW', length: 256 });
		expect([...kek.usages].sort()).toEqual(['unwrapKey', 'wrapKey']);
		await expect(crypto.subtle.exportKey('raw', macKey)).rejects.toThrow();
		await expect(crypto.subtle.exportKey('raw', kek)).rejects.toThrow();
	});

	it('argon2id gets the PIN bytes, the PIN salt and the backup tuple with the same memory cap', async () => {
		let pinAtCall: number[] = [];
		mocks.argon2id.mockImplementation((pin: Uint8Array) => {
			pinAtCall = [...pin];
			return Uint8Array.from(FAKE_OUTPUT);
		});
		const salt = saltOf();
		await runDerivePin(PIN_TEXT, salt);
		expect(mocks.argon2id).toHaveBeenCalledTimes(1);
		const [, calledSalt, opts] = mocks.argon2id.mock.calls[0] as [
			Uint8Array,
			Uint8Array,
			ArgonOptions
		];
		expect(Object.keys(opts).sort()).toEqual(
			['dkLen', 'm', 'maxmem', 'onProgress', 'p', 't', 'version'].sort()
		);
		expect(opts).toMatchObject({
			t: KDF_V1.t,
			m: KDF_V1.m,
			p: KDF_V1.p,
			version: KDF_V1.v,
			dkLen: KDF_V1.dkLen,
			maxmem: MAXMEM
		});
		expect(pinAtCall).toEqual([...new TextEncoder().encode(PIN_TEXT)]);
		expect([...calledSalt]).toEqual([...salt]);
	});

	// The backup's key and the PIN's MAC key come from the same kind of step; a different label is what keeps one
	// from standing in for the other.
	it('a key made with the backup label over the same output does not verify a PIN MAC', async () => {
		const salt = saltOf();
		const { macKey } = pinKeysOf((await runDerivePin(PIN_TEXT, salt)).posts);
		const message = new TextEncoder().encode(KAT_PIN_MAC_MESSAGE);
		const mac = await crypto.subtle.sign('HMAC', macKey, message);
		expect(await crypto.subtle.verify('HMAC', macKey, mac, message)).toBe(true);

		const material = await crypto.subtle.importKey(
			'raw',
			Uint8Array.from(FAKE_OUTPUT),
			'HKDF',
			false,
			['deriveKey']
		);
		const backupLabelled = await crypto.subtle.deriveKey(
			{ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(HKDF_INFO_V1) },
			material,
			{ name: 'HMAC', hash: 'SHA-256', length: 256 },
			false,
			['sign', 'verify']
		);
		expect(await crypto.subtle.verify('HMAC', backupLabelled, mac, message)).toBe(false);
	});

	it('a RangeError from argon2id posts NO_MEMORY and any other throw posts WORKER_FAILED', async () => {
		mocks.argon2id.mockImplementation(() => {
			throw new RangeError('Array buffer allocation failed');
		});
		expect((await runDerivePin()).posts).toEqual([{ type: 'error', code: 'E_NO_MEMORY' }]);
		mocks.argon2id.mockImplementation(() => {
			throw new Error('maxmem limit was hit');
		});
		expect((await runDerivePin()).posts).toEqual([{ type: 'error', code: 'E_WORKER_FAILED' }]);
	});
});

describe('derive-pin: the answer matches an independent computation', () => {
	// Argon2id here is the real noble at a small tuple (the full one is too slow for this suite and is checked through
	// the built worker by the end-to-end spec). The expected values were computed outside this repository's code, so
	// swapped labels, a wrong HKDF salt or a wrong algorithm all fail here.
	it('gives the small-tuple Argon2id output, MAC proof and wrap proof', async () => {
		const actual =
			await vi.importActual<typeof import('@noble/hashes/argon2.js')>('@noble/hashes/argon2.js');
		let argonHex = '';
		mocks.argon2id.mockImplementation((pin: Uint8Array, salt: Uint8Array, opts: ArgonOptions) => {
			const output = actual.argon2id(pin, salt, {
				...(opts as object),
				t: 1,
				m: 64,
				p: 1
			} as Parameters<typeof actual.argon2id>[2]);
			argonHex = hex(output);
			return output;
		});
		const { macKey, kek } = pinKeysOf((await runDerivePin(PIN_TEXT, KAT_SALT)).posts);
		expect(argonHex).toBe(KAT_PIN_SMALL.argon2Hex);

		const mac = await crypto.subtle.sign(
			'HMAC',
			macKey,
			new TextEncoder().encode(KAT_PIN_MAC_MESSAGE)
		);
		expect(hex(mac)).toBe(KAT_PIN_SMALL.macHex);

		// Extractable only so the test can hand its bytes to the wrap; the derived keys stay non-extractable.
		const toWrap = await crypto.subtle.importKey(
			'raw',
			KAT_PIN_WRAPPED_KEY,
			{ name: 'HMAC', hash: 'SHA-256' },
			true,
			['sign']
		);
		const wrapped = await crypto.subtle.wrapKey('raw', toWrap, kek, 'AES-KW');
		expect(hex(wrapped)).toBe(KAT_PIN_SMALL.wrapHex);
	});
});

describe('derive-pin: the PIN bytes and the Argon2id output are wiped on every path', () => {
	type Arrange = () => void;
	const crashes =
		(spy: () => { mockRejectedValue: (reason: unknown) => unknown }): Arrange =>
		() => {
			spy().mockRejectedValue(new Error('no'));
		};

	async function wiped(
		arrange: Arrange
	): Promise<{ posts: FromWorker[]; pin: ArrayBuffer; out?: Uint8Array }> {
		let out: Uint8Array | undefined;
		mocks.argon2id.mockImplementation(() => {
			out = Uint8Array.from(FAKE_OUTPUT);
			return out;
		});
		arrange();
		try {
			const { posts, pass } = await runDerivePin();
			return out === undefined ? { posts, pin: pass } : { posts, pin: pass, out };
		} finally {
			vi.restoreAllMocks();
		}
	}

	it('success: both are zero and the keys exist', async () => {
		const { posts, pin, out } = await wiped(() => undefined);
		expect(posts.at(-1)?.type).toBe('pin-keys');
		expect(isZero(pin)).toBe(true);
		expect(out?.every((byte) => byte === 0)).toBe(true);
	});

	it('NO_MEMORY: the PIN is zero', async () => {
		const { posts, pin } = await wiped(() => {
			mocks.argon2id.mockImplementation(() => {
				throw new RangeError('Array buffer allocation failed');
			});
		});
		expect(posts).toEqual([{ type: 'error', code: 'E_NO_MEMORY' }]);
		expect(isZero(pin)).toBe(true);
	});

	it.each([
		['importKey', crashes(() => vi.spyOn(crypto.subtle, 'importKey'))],
		['deriveKey', crashes(() => vi.spyOn(crypto.subtle, 'deriveKey'))]
	])('a crypto failure in %s: both are zero and no key is posted', async (_n, arrange) => {
		const { posts, pin, out } = await wiped(arrange);
		expect(posts.at(-1)).toEqual({ type: 'error', code: 'E_CRYPTO_FAILED' });
		expect(posts.some((msg) => msg.type === 'pin-keys')).toBe(false);
		expect(isZero(pin)).toBe(true);
		expect(out).toBeDefined();
		expect(out?.every((byte) => byte === 0)).toBe(true);
	});
});

describe('privacy of what is posted', () => {
	// Each answer has exactly these own keys and no others, so a stray field (an echoed phrase, an error's text) fails.
	const SHAPES: Record<string, { required: string[]; optional: string[] }> = {
		error: { required: ['type', 'code'], optional: ['position'] },
		progress: { required: ['type', 'percent'], optional: [] },
		key: { required: ['type', 'key'], optional: [] },
		words: { required: ['type', 'words'], optional: [] }
	};

	function expectExactShape(msg: FromWorker): void {
		const shape = SHAPES[msg.type];
		expect(shape).toBeDefined();
		if (shape === undefined) return;
		const keys = Object.keys(msg);
		const allowed = [...shape.required, ...shape.optional];
		for (const key of shape.required) expect(keys).toContain(key);
		for (const key of keys) expect(allowed).toContain(key);
	}

	// Everything except the type and code literals, as text: a token anywhere inside (a field, a nested value, an
	// array) shows up here. A CryptoKey serialises to {}.
	function expectNoToken(msg: FromWorker, tokens: readonly string[]): void {
		const text = JSON.stringify(msg, (name, value: unknown) =>
			name === 'type' || name === 'code' ? undefined : value
		).toLowerCase();
		for (const token of tokens) expect(text).not.toContain(token.toLowerCase());
	}

	type Scenario = [name: string, run: () => Promise<FromWorker[]>, tokens: string[]];

	async function viaHandle(message: unknown): Promise<FromWorker[]> {
		const posts: FromWorker[] = [];
		const { handle } = createHandler(WORDS_V1, (msg) => posts.push(msg));
		await handle(message);
		return posts;
	}

	function deriving(
		text: string,
		arrange: () => void = () => undefined
	): () => Promise<FromWorker[]> {
		return async () => {
			mocks.argon2id.mockImplementation(fakeArgon);
			arrange();
			return (await runDerive(text)).posts;
		};
	}

	function argonThrows(thrown: unknown): () => void {
		return () => {
			mocks.argon2id.mockImplementation(() => {
				throw thrown;
			});
		};
	}

	function withSpy<T>(restore: () => void, run: () => Promise<T>): Promise<T> {
		return run().finally(restore);
	}

	const PHRASE_TOKENS = [...PHRASE, NOT_A_WORD];
	const SCENARIOS: Scenario[] = [
		['an unknown word', deriving(swapWord(3, NOT_A_WORD)), PHRASE_TOKENS],
		['a success', deriving(PHRASE_TEXT), PHRASE_TOKENS],
		['upper case input', deriving(PHRASE_TEXT.toUpperCase()), PHRASE_TOKENS],
		['twelve words', deriving(`${PHRASE_TEXT} ${PHRASE_TEXT}`), PHRASE_TOKENS],
		['a double space', deriving(PHRASE_TEXT.replace(' ', '  ')), PHRASE_TOKENS],
		[
			'a RangeError carrying the phrase',
			deriving(PHRASE_TEXT, argonThrows(new RangeError(PHRASE_TEXT))),
			PHRASE_TOKENS
		],
		[
			'an Error carrying the phrase',
			deriving(PHRASE_TEXT, argonThrows(new Error(PHRASE_TEXT))),
			PHRASE_TOKENS
		],
		[
			'a string thrown carrying the phrase',
			deriving(PHRASE_TEXT, argonThrows(PHRASE_TEXT)),
			PHRASE_TOKENS
		],
		[
			'an importKey failure carrying the phrase',
			() => {
				const spy = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new Error(PHRASE_TEXT));
				return withSpy(() => spy.mockRestore(), deriving(PHRASE_TEXT));
			},
			PHRASE_TOKENS
		],
		[
			'a deriveKey failure carrying the phrase',
			() => {
				const spy = vi.spyOn(crypto.subtle, 'deriveKey').mockRejectedValue(new Error(PHRASE_TEXT));
				return withSpy(() => spy.mockRestore(), deriving(PHRASE_TEXT));
			},
			PHRASE_TOKENS
		],
		[
			'a derive request with an extra key',
			() =>
				viaHandle({
					op: 'derive',
					purpose: 'restore',
					pass: bufferOf(PHRASE_TEXT),
					salt: saltOf(),
					extra: PHRASE_TEXT
				}),
			PHRASE_TOKENS
		],
		[
			'a request whose op is the phrase',
			() => viaHandle({ op: PHRASE_TEXT, pass: bufferOf(PHRASE_TEXT) }),
			PHRASE_TOKENS
		],
		['a request that is the phrase', () => viaHandle(PHRASE_TEXT), PHRASE_TOKENS],
		[
			'a request with a short salt',
			() =>
				viaHandle({
					op: 'derive',
					purpose: 'export',
					pass: bufferOf(PHRASE_TEXT),
					salt: saltOf(3)
				}),
			PHRASE_TOKENS
		],
		['generate', () => viaHandle({ op: 'generate' }), []]
	];

	it.each(SCENARIOS)(
		'every post has exactly its own keys and holds no passphrase token (%s)',
		async (_name, run, tokens) => {
			const posts = await run();
			expect(posts.length).toBeGreaterThan(0);
			for (const msg of posts) {
				expectExactShape(msg);
				if (msg.type !== 'words') expectNoToken(msg, tokens);
			}
		}
	);

	it('the scenarios cover every answer type', async () => {
		const seen = new Set<string>();
		for (const [, run] of SCENARIOS) for (const msg of await run()) seen.add(msg.type);
		expect([...seen].sort()).toEqual(['error', 'key', 'progress', 'words']);
	});

	it('a words post is only ever the generate answer', async () => {
		for (const [name, run] of SCENARIOS) {
			if (name === 'generate') continue;
			for (const msg of await run()) expect(msg.type).not.toBe('words');
		}
	});
});
