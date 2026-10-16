import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HKDF_INFO_V1, KDF_V1 } from '../kdf-params';
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

beforeEach(() => {
	mocks.argon2id.mockReset();
	mocks.argon2idAsync.mockReset();
	mocks.argon2id.mockImplementation((_pass: Uint8Array, _salt: Uint8Array, opts: ArgonOptions) => {
		opts.onProgress?.(0.5);
		opts.onProgress?.(1);
		return Uint8Array.from(FAKE_OUTPUT);
	});
});

describe('derive: the word check comes first', () => {
	it.each([1, 2, 3, 4, 5, 6])(
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

	it.each([
		['a double space', `${PHRASE[0]}  ${PHRASE.slice(1).join(' ')}`],
		['a capital letter', PHRASE_TEXT.replace(PHRASE[0] ?? '', (PHRASE[0] ?? '').toUpperCase())],
		['five words', PHRASE.slice(0, 5).join(' ')],
		['a trailing space', `${PHRASE_TEXT} `],
		['a line break', PHRASE_TEXT.replace(' ', '\n')]
	])(
		'non-canonical bytes (%s) post WORKER_FAILED and argon2id is never called',
		async (_n, text) => {
			const { posts, pass } = await runDerive(text);
			expect(posts).toEqual([{ type: 'error', code: 'E_WORKER_FAILED' }]);
			expect(argonCalls()).toBe(0);
			expect(isZero(pass)).toBe(true);
		}
	);
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
		const import_ = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new Error('no'));
		try {
			const { pass, posts } = await runDerive(PHRASE_TEXT);
			expect(posts.at(-1)).toEqual({ type: 'error', code: 'E_CRYPTO_FAILED' });
			expect(posts.some((msg) => msg.type === 'key')).toBe(false);
			expect(isZero(pass)).toBe(true);
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

	it('argon2idAsync is never called', async () => {
		await runDerive(PHRASE_TEXT);
		await runDerive(swapWord(1, NOT_A_WORD));
		expect(mocks.argon2idAsync).not.toHaveBeenCalled();
		expect(mocks.argon2id).toHaveBeenCalledTimes(1);
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

	it.each([
		['an Error', new Error('maxmem limit was hit')],
		['a TypeError', new TypeError('bad input')],
		['a string', 'out of memory']
	])('any other throw (%s) maps to WORKER_FAILED', async (_name, thrown) => {
		mocks.argon2id.mockImplementation(() => {
			throw thrown;
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
		const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, reference, sealed);
		expect([...new Uint8Array(opened)]).toEqual([...block]);

		const restoreKey = keyOf((await runDerive(PHRASE_TEXT, 'restore', salt)).posts);
		const sealedByReference = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			reference,
			block
		);
		const openedByRestore = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv },
			restoreKey,
			sealedByReference
		);
		expect([...new Uint8Array(openedByRestore)]).toEqual([...block]);
	});

	it('a key from another salt, another info or another output does not open it', async () => {
		const salt = saltOf();
		const iv = new Uint8Array(12);
		const exportKey = keyOf((await runDerive(PHRASE_TEXT, 'export', salt)).posts);
		const sealed = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			exportKey,
			new Uint8Array(16)
		);
		const other = [
			await referenceKey(Uint8Array.from(FAKE_OUTPUT), saltOf(17), 'ask214-backup-v1/aes-gcm-256'),
			await referenceKey(Uint8Array.from(FAKE_OUTPUT), salt, 'ask214-backup-v1/other'),
			await referenceKey(new Uint8Array(32), salt, 'ask214-backup-v1/aes-gcm-256')
		];
		for (const key of other) {
			await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed)).rejects.toThrow();
		}
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

describe('privacy of what is posted', () => {
	it('nothing posted ever holds a passphrase token', async () => {
		const throwing = (thrown: unknown) => () => {
			mocks.argon2id.mockImplementation(() => {
				throw thrown;
			});
		};
		const scenarios: [string, () => void][] = [
			[swapWord(3, NOT_A_WORD), () => undefined],
			[PHRASE_TEXT, () => undefined],
			[PHRASE_TEXT, throwing(new RangeError(PHRASE_TEXT))],
			[PHRASE_TEXT, throwing(new Error(PHRASE_TEXT))],
			[PHRASE_TEXT.toUpperCase(), () => undefined],
			[`${PHRASE_TEXT} ${PHRASE_TEXT}`, () => undefined]
		];
		const strings: string[] = [];
		for (const [text, arrange] of scenarios) {
			arrange();
			const { posts } = await runDerive(text);
			for (const msg of posts) {
				for (const value of Object.values(msg)) if (typeof value === 'string') strings.push(value);
			}
			mocks.argon2id.mockReset();
			mocks.argon2id.mockImplementation(() => Uint8Array.from(FAKE_OUTPUT));
		}
		expect(strings.length).toBeGreaterThan(0);
		const tokens = new Set([...PHRASE, NOT_A_WORD, ...PHRASE_TEXT.toUpperCase().split(' ')]);
		for (const text of strings) expect(tokens.has(text)).toBe(false);
		for (const text of strings) expect(text).not.toContain(NOT_A_WORD);
	});
});
