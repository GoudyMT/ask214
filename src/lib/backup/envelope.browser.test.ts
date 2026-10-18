import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
	MAX_CIPHERTEXT_BYTES,
	MAX_FILE_BYTES,
	MAX_PADDED_PLAINTEXT_BYTES,
	MAX_DATA_B64_CHARS,
	ENVELOPE_FIXED_BYTES
} from './caps';
import { buildBackupAad } from './aad';
import { BackupError } from './codes';
import { serializeEnvelope } from './envelope-json';
import {
	newBackupSalt,
	sealEnvelope,
	readBackupFile,
	decryptEnvelope,
	type ParsedEnvelope
} from './envelope';

// Records what the real AES-GCM wrapper was given and what it returned, so a test can read the plaintext arrays after
// the promise has resolved and see whether they were wiped. The path is a `$lib` alias on purpose: a relative path
// here silently never reaches the module under test's own import in this browser runner.
const seams = vi.hoisted(() => ({
	plaintexts: [] as Uint8Array[],
	decrypted: [] as Uint8Array[],
	decryptCalls: 0
}));

vi.mock('$lib/crypto/aes-gcm', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../crypto/aes-gcm')>();
	return {
		...actual,
		aesGcmEncrypt: async (...args: Parameters<typeof actual.aesGcmEncrypt>) => {
			seams.plaintexts.push(args[3]);
			return actual.aesGcmEncrypt(...args);
		},
		aesGcmDecrypt: async (...args: Parameters<typeof actual.aesGcmDecrypt>) => {
			seams.decryptCalls += 1;
			const out = await actual.aesGcmDecrypt(...args);
			seams.decrypted.push(out);
			return out;
		}
	};
});

// The whole file runs with a file-size bound widened by 4,096 bytes of slack, so the one test that needs a ciphertext
// over the cap can pass the size check and meet only the ciphertext bound. The factory is evaluated once, so the
// numbers are plain values: a getter is flattened and a later `doMock` does not reach a module already loaded.
// Every other cap is the real one, and the real size bound is pinned in caps.test.ts.
vi.mock('$lib/backup/caps', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./caps')>();
	return {
		...actual,
		FILE_SLACK_BYTES: 8192,
		MAX_FILE_BYTES: actual.ENVELOPE_FIXED_BYTES + actual.MAX_DATA_B64_CHARS + 8192
	};
});

// What MAX_FILE_BYTES really is (4,096 bytes of slack), for the checks that a file fits the real bound.
const REAL_MAX_FILE_BYTES = ENVELOPE_FIXED_BYTES + MAX_DATA_B64_CHARS + 4096;

const enc = new TextEncoder();
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toB64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let bin = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

function fromB64(s: string): Uint8Array {
	const bin = atob(s);
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function counting(n: number, start = 0): Uint8Array<ArrayBuffer> {
	return Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
}

function importAesKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

type Env = Record<string, unknown> & {
	kdf: Record<string, unknown>;
	cipher: Record<string, unknown>;
};

function edit(text: string, fn: (e: Env) => void): string {
	const parsed = JSON.parse(text) as Env;
	fn(parsed);
	return JSON.stringify(parsed);
}

// A well-formed envelope around `ctBytes` zero bytes of "ciphertext" whose check is valid for them, so a test can
// reach every rule that sits before or after the check on its own. It is never decrypted.
async function handBuilt(ctBytes: number): Promise<string> {
	const salt = counting(16);
	const iv = counting(12);
	const ct = new Uint8Array(ctBytes);
	const aad = enc.encode(buildBackupAad(salt, iv));
	const check = await sha256(concat(aad, ct));
	return serializeEnvelope({
		salt: toB64(salt),
		iv: toB64(iv),
		check: toB64(check),
		data: toB64(ct)
	});
}

function flip(o: Record<string, unknown>, k: string): void {
	const bytes = fromB64(o[k] as string);
	bytes[0] = (bytes[0] ?? 0) ^ 1;
	o[k] = toB64(bytes);
}

function fileOf(text: string): File {
	return new File([text], 'backup.json');
}

const SALT = counting(16);
let keyA: CryptoKey;
let keyB: CryptoKey;
let good: string;

beforeAll(async () => {
	keyA = await importAesKey(counting(32, 1));
	keyB = await importAesKey(counting(32, 101));
	good = await sealEnvelope(keyA, enc.encode('{"hello":"world"}'), SALT);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	seams.plaintexts.length = 0;
	seams.decrypted.length = 0;
	seams.decryptCalls = 0;
});

async function mustRead(text: string): Promise<ParsedEnvelope> {
	const r = await readBackupFile(fileOf(text));
	if (!r.ok) throw new Error('E_TEST_EXPECTED_A_GOOD_FILE');
	return r.envelope;
}

describe('seal, read, decrypt', () => {
	it('seal then read then decrypt returns the inner JSON', async () => {
		const env = await mustRead(good);
		const out = await decryptEnvelope(env, keyA);
		expect(out).toEqual({ ok: true, inner: { hello: 'world' } });
	});

	it('a good file reads to a fresh object holding only salt, iv and ct', async () => {
		const r = await readBackupFile(fileOf(good));
		if (!r.ok) throw new Error('expected ok');
		const parsed = JSON.parse(good) as Env;
		expect(Object.keys(r.envelope).sort()).toEqual(['ct', 'iv', 'salt']);
		expect(Array.from(r.envelope.salt)).toEqual(Array.from(fromB64(parsed.kdf['salt'] as string)));
		expect(Array.from(r.envelope.iv)).toEqual(Array.from(fromB64(parsed.cipher['iv'] as string)));
		expect(Array.from(r.envelope.ct)).toEqual(Array.from(fromB64(parsed['data'] as string)));
	});

	it('GCM failure with a matching check is WRONG_PASSPHRASE', async () => {
		const env = await mustRead(good);
		expect(await decryptEnvelope(env, keyB)).toEqual({ ok: false, code: 'E_WRONG_PASSPHRASE' });
	});

	it('a browser failure that is not an auth failure is CRYPTO_FAILED', async () => {
		const env = await mustRead(good);
		const notAes = await crypto.subtle.importKey(
			'raw',
			counting(32),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		expect(await decryptEnvelope(env, notAes)).toEqual({ ok: false, code: 'E_CRYPTO_FAILED' });
	});

	it('inner bytes that open but are not JSON are CONTENT_INVALID', async () => {
		const text = await sealEnvelope(keyA, enc.encode('not json at all'), SALT);
		const out = await decryptEnvelope(await mustRead(text), keyA);
		expect(out).toEqual({ ok: false, code: 'E_CONTENT_INVALID' });
	});

	it('inner bytes that open but are not UTF-8 are CONTENT_INVALID', async () => {
		const text = await sealEnvelope(keyA, Uint8Array.from([0x22, 0xff, 0x22]), SALT);
		const out = await decryptEnvelope(await mustRead(text), keyA);
		expect(out).toEqual({ ok: false, code: 'E_CONTENT_INVALID' });
	});
});

describe('field mutations are DAMAGED', () => {
	const rows: [string, (e: Env) => void][] = [
		['m 131073', (e) => (e.kdf['m'] = 131073)],
		['m the string "131072"', (e) => (e.kdf['m'] = '131072')],
		['m 1048576', (e) => (e.kdf['m'] = 1048576)],
		['t 3', (e) => (e.kdf['t'] = 3)],
		['t 5', (e) => (e.kdf['t'] = 5)],
		['p 1', (e) => (e.kdf['p'] = 1)],
		['p 3', (e) => (e.kdf['p'] = 3)],
		['v 16', (e) => (e.kdf['v'] = 16)],
		['v the string "19"', (e) => (e.kdf['v'] = '19')],
		['an extra top key', (e) => (e['extra'] = 1)],
		['an extra kdf key', (e) => (e.kdf['extra'] = 1)],
		['an extra cipher key', (e) => (e.cipher['extra'] = 1)],
		['a missing check', (e) => delete e['check']],
		['a missing data', (e) => delete e['data']],
		['a missing kdf key', (e) => delete e.kdf['t']],
		['kdf not an object', (e) => ((e as Record<string, unknown>)['kdf'] = 'argon2id')],
		['kdf an array', (e) => ((e as Record<string, unknown>)['kdf'] = [])],
		['cipher null', (e) => ((e as Record<string, unknown>)['cipher'] = null)],
		['salt 15 bytes', (e) => (e.kdf['salt'] = toB64(counting(15)))],
		['salt 17 bytes', (e) => (e.kdf['salt'] = toB64(counting(17)))],
		['iv 11 bytes', (e) => (e.cipher['iv'] = toB64(counting(11)))],
		['iv 13 bytes', (e) => (e.cipher['iv'] = toB64(counting(13)))],
		['check 31 bytes', (e) => (e['check'] = toB64(counting(31)))],
		['kdf alg argon2i', (e) => (e.kdf['alg'] = 'argon2i')],
		['cipher alg AES-CBC', (e) => (e.cipher['alg'] = 'AES-CBC')],
		['salt a number', (e) => (e.kdf['salt'] = 5)],
		['check a number', (e) => (e['check'] = 5)],
		['data a number', (e) => (e['data'] = 5)],
		['version missing', (e) => delete e['version']],
		['version 0', (e) => (e['version'] = 0)],
		['version -1', (e) => (e['version'] = -1)],
		['version the string "1"', (e) => (e['version'] = '1')],
		['version 1.5', (e) => (e['version'] = 1.5)],
		['version null', (e) => (e['version'] = null)]
	];

	it.each(rows)('%s', async (_name, mutate) => {
		const r = await readBackupFile(fileOf(edit(good, mutate)));
		expect(r).toEqual({ ok: false, code: 'E_DAMAGED' });
	});

	// Each file below carries a VALID check for its own data, so only the data-shape rule (at least one pad block plus
	// the tag, and 16 past a multiple of 4,096) can refuse it; the check cannot.
	it.each([
		[0, 'empty'],
		[16, 'a tag alone, below the minimum'],
		[4111, 'one byte under the minimum'],
		[4113, 'one byte over a valid length'],
		[4128, 'a multiple of 16 but not 16 past a 4096 multiple'],
		[8192, 'a whole number of blocks with no tag'],
		[8209, 'one byte over the second valid length']
	])('data of %i bytes (%s) with a valid check is DAMAGED', async (bytes) => {
		const r = await readBackupFile(fileOf(await handBuilt(bytes)));
		expect(r).toEqual({ ok: false, code: 'E_DAMAGED' });
	});

	it.each([4112, 8208])('data of %i bytes with a valid check is accepted', async (bytes) => {
		const r = await readBackupFile(fileOf(await handBuilt(bytes)));
		expect(r.ok).toBe(true);
	});

	it('an own __proto__ key', async () => {
		const surgery = good.replace('{"format"', '{"__proto__":{},"format"');
		expect(surgery).not.toBe(good);
		expect(Object.keys(JSON.parse(surgery) as object)).toContain('__proto__');
		expect(await readBackupFile(fileOf(surgery))).toEqual({ ok: false, code: 'E_DAMAGED' });
	});

	it('an own __proto__ key inside kdf', async () => {
		const surgery = good.replace('"kdf":{', '"kdf":{"__proto__":{},');
		expect(surgery).not.toBe(good);
		expect(await readBackupFile(fileOf(surgery))).toEqual({ ok: false, code: 'E_DAMAGED' });
	});

	it('the unedited fixture is accepted (so each row above fails for its own edit)', async () => {
		const r = await readBackupFile(fileOf(edit(good, () => undefined)));
		expect(r.ok).toBe(true);
	});

	it('whitespace around the JSON is accepted', async () => {
		const r = await readBackupFile(fileOf('\n  ' + good + '\r\n\n'));
		expect(r.ok).toBe(true);
	});
});

describe('version', () => {
	it('version 2 is NEWER_VERSION', async () => {
		const r = await readBackupFile(fileOf(edit(good, (e) => (e['version'] = 2))));
		expect(r).toEqual({ ok: false, code: 'E_NEWER_VERSION' });
	});

	it('version 2 with keys this version does not know is still NEWER_VERSION', async () => {
		const text = edit(good, (e) => {
			e['version'] = 2;
			e['newThing'] = { a: 1 };
			delete e.kdf['t'];
		});
		expect(await readBackupFile(fileOf(text))).toEqual({ ok: false, code: 'E_NEWER_VERSION' });
	});

	it('version 2 with a wrong format is NOT_BACKUP (the format check runs first)', async () => {
		const text = edit(good, (e) => {
			e['version'] = 2;
			e['format'] = 'other';
		});
		expect(await readBackupFile(fileOf(text))).toEqual({ ok: false, code: 'E_NOT_BACKUP' });
	});
});

describe('strict base64', () => {
	// The good fixture's data is 4112 bytes, so its base64 ends in exactly one "=".
	function nonCanonical(d: string): string {
		const last = d.charAt(d.length - 2);
		const idx = B64_ALPHABET.indexOf(last);
		return d.slice(0, -2) + B64_ALPHABET.charAt(idx | 1) + '=';
	}

	it('the fixture ends in one pad and the non-canonical form still decodes', () => {
		const data = (JSON.parse(good) as Env)['data'] as string;
		expect(data.endsWith('=')).toBe(true);
		expect(data.endsWith('==')).toBe(false);
		const bad = nonCanonical(data);
		expect(bad).not.toBe(data);
		expect(() => atob(bad)).not.toThrow();
		expect(toB64(fromB64(bad))).toBe(data);
	});

	const rows: [string, (d: string) => string][] = [
		['a space inside', (d) => d.slice(0, 8) + ' ' + d.slice(8)],
		['a newline inside', (d) => d.slice(0, 8) + '\n' + d.slice(8)],
		['URL-safe minus', (d) => '-' + d.slice(1)],
		['URL-safe underscore', (d) => '_' + d.slice(1)],
		['a missing pad', (d) => d.replace(/=+$/, '')],
		['an extra pad', (d) => d + '='],
		['a non-canonical last character', nonCanonical]
	];

	it.each(rows)('data with %s is DAMAGED', async (_name, mutate) => {
		const text = edit(good, (e) => (e['data'] = mutate(e['data'] as string)));
		expect(await readBackupFile(fileOf(text))).toEqual({ ok: false, code: 'E_DAMAGED' });
	});

	it.each([
		['salt', (e: Env) => (e.kdf['salt'] = ' ' + (e.kdf['salt'] as string).slice(1))],
		['iv', (e: Env) => (e.cipher['iv'] = '-' + (e.cipher['iv'] as string).slice(1))],
		[
			'check',
			(e: Env) =>
				(e['check'] = (e['check'] as string).slice(0, 4) + ' ' + (e['check'] as string).slice(5))
		]
	])('a bad character in %s is DAMAGED', async (_name, mutate) => {
		expect(await readBackupFile(fileOf(edit(good, mutate)))).toEqual({
			ok: false,
			code: 'E_DAMAGED'
		});
	});
});

describe('the check', () => {
	it('a flipped data bit is DAMAGED, and no key work ran', async () => {
		const text = edit(good, (e) => {
			const bytes = fromB64(e['data'] as string);
			bytes[0] = (bytes[0] ?? 0) ^ 1;
			e['data'] = toB64(bytes);
		});
		expect(await readBackupFile(fileOf(text))).toEqual({ ok: false, code: 'E_DAMAGED' });
		expect(seams.decryptCalls).toBe(0);
	});

	it('a flipped bit in the tag is DAMAGED', async () => {
		const text = edit(good, (e) => {
			const bytes = fromB64(e['data'] as string);
			bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x80;
			e['data'] = toB64(bytes);
		});
		expect(await readBackupFile(fileOf(text))).toEqual({ ok: false, code: 'E_DAMAGED' });
	});

	it.each([
		['salt', (e: Env) => flip(e.kdf, 'salt')],
		['iv', (e: Env) => flip(e.cipher, 'iv')],
		['check', (e: Env) => flip(e, 'check')]
	])('a flipped bit in %s is DAMAGED', async (_name, mutate) => {
		expect(await readBackupFile(fileOf(edit(good, mutate)))).toEqual({
			ok: false,
			code: 'E_DAMAGED'
		});
	});
});

describe('not a backup', () => {
	const notUtf8 = Uint8Array.from([0xff, 0xfe, 0x00, 0x41]);
	const rows: [string, BlobPart][] = [
		['not JSON', 'this is not json {'],
		['empty', ''],
		['not UTF-8', notUtf8],
		['an array', '[]'],
		['null', 'null'],
		['a number', '42'],
		['a string', '"ask214-backup"'],
		['an empty object', '{}'],
		['another format', '{"format":"other-app","version":1}'],
		['a format that is not a string', '{"format":5,"version":1}']
	];

	it.each(rows)('%s -> NOT_BACKUP', async (_name, part) => {
		const r = await readBackupFile(new File([part], 'x.json'));
		expect(r).toEqual({ ok: false, code: 'E_NOT_BACKUP' });
	});
});

describe('size caps', () => {
	it('a file of exactly MAX_FILE_BYTES is read', async () => {
		const padded = good + ' '.repeat(MAX_FILE_BYTES - good.length);
		const file = fileOf(padded);
		expect(file.size).toBe(MAX_FILE_BYTES);
		const r = await readBackupFile(file);
		expect(r.ok).toBe(true);
	});

	it('a file of MAX_FILE_BYTES + 1 of whitespace-padded JSON is refused', async () => {
		const file = fileOf(good + ' '.repeat(MAX_FILE_BYTES + 1 - good.length));
		expect(file.size).toBe(MAX_FILE_BYTES + 1);
		expect(await readBackupFile(file)).toEqual({ ok: false, code: 'E_FILE_TOO_LARGE' });
	});

	it('with FILE_SLACK_BYTES mocked to 8192, a ciphertext one 4,096-byte bucket over the cap is FILE_TOO_LARGE', async () => {
		const text = await handBuilt(MAX_CIPHERTEXT_BYTES + 4096);
		const file = fileOf(text);
		// The file passes the widened size bound (the mock above) and would not pass the real one, so only the
		// ciphertext bound can refuse it.
		expect(MAX_FILE_BYTES).toBe(ENVELOPE_FIXED_BYTES + MAX_DATA_B64_CHARS + 8192);
		expect(file.size).toBeLessThanOrEqual(MAX_FILE_BYTES);
		expect(file.size).toBeGreaterThan(REAL_MAX_FILE_BYTES);
		// Only the code is compared: a result holding megabytes of bytes would overflow the test runner's socket on a
		// failure, hiding the assertion.
		const r = await readBackupFile(file);
		expect(r.ok ? 'accepted' : r.code).toBe('E_FILE_TOO_LARGE');
	});

	it('a ciphertext exactly at the cap is accepted', async () => {
		const text = await handBuilt(MAX_CIPHERTEXT_BYTES);
		const file = fileOf(text);
		expect(file.size).toBeLessThanOrEqual(REAL_MAX_FILE_BYTES);
		const r = await readBackupFile(file);
		expect(r.ok).toBe(true);
	});

	it('inner exactly at the cap seals into a file inside the real file bound that reads and opens', async () => {
		const inner = new Uint8Array(MAX_PADDED_PLAINTEXT_BYTES).fill(0x20);
		inner[0] = 0x37;
		const text = await sealEnvelope(keyA, inner, SALT);
		expect(enc.encode(text).length).toBeLessThanOrEqual(REAL_MAX_FILE_BYTES);
		const env = await mustRead(text);
		expect(env.ct.length).toBe(MAX_CIPHERTEXT_BYTES);
		expect(await decryptEnvelope(env, keyA)).toEqual({ ok: true, inner: 7 });
	});

	it('a file of MAX_FILE_BYTES + 1 is refused before arrayBuffer', async () => {
		const file = new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'big.json');
		const arrayBuffer = vi.spyOn(Blob.prototype, 'arrayBuffer');
		const slice = vi.spyOn(file, 'slice');
		expect(await readBackupFile(file)).toEqual({ ok: false, code: 'E_FILE_TOO_LARGE' });
		expect(arrayBuffer).not.toHaveBeenCalled();
		expect(slice).not.toHaveBeenCalled();
	});

	it('slice is called with 0 and MAX_FILE_BYTES + 1', async () => {
		const file = fileOf(good);
		const slice = vi.spyOn(file, 'slice');
		const r = await readBackupFile(file);
		expect(r.ok).toBe(true);
		expect(slice).toHaveBeenCalledTimes(1);
		expect(slice).toHaveBeenCalledWith(0, MAX_FILE_BYTES + 1);
	});

	it('a file whose reported size understates its bytes is refused after the sliced read', async () => {
		class LyingFile extends File {
			constructor(parts: BlobPart[], name: string) {
				super(parts, name);
				Object.defineProperty(this, 'size', { value: 10 });
			}
		}
		const file = new LyingFile([new Uint8Array(MAX_FILE_BYTES + 1).fill(0x20)], 'lie.json');
		expect(file.size).toBe(10);
		const arrayBuffer = vi.spyOn(Blob.prototype, 'arrayBuffer');
		expect(await readBackupFile(file)).toEqual({ ok: false, code: 'E_FILE_TOO_LARGE' });
		expect(arrayBuffer).toHaveBeenCalledTimes(1);
	});
});

describe('padding and wiping', () => {
	async function dataLength(innerLength: number): Promise<number> {
		const text = await sealEnvelope(keyA, new Uint8Array(innerLength).fill(0x37), SALT);
		return fromB64((JSON.parse(text) as Env)['data'] as string).length;
	}

	it.each([
		[0, 4112],
		[4096, 4112],
		[4097, 8208]
	])('inner of %i bytes gives %i decoded data bytes', async (innerLength, expected) => {
		expect(await dataLength(innerLength)).toBe(expected);
	});

	it('the padded plaintext copy is zero after seal, and inner is left alone', async () => {
		const inner = enc.encode('{"keep":"me"}');
		const before = Array.from(inner);
		await sealEnvelope(keyA, inner, SALT);
		expect(seams.plaintexts).toHaveLength(1);
		const padded = seams.plaintexts[0];
		expect(padded).toBeDefined();
		expect(padded).not.toBe(inner);
		expect(padded?.length).toBe(4096);
		expect(padded?.every((b) => b === 0)).toBe(true);
		expect(Array.from(inner)).toEqual(before);
	});

	it('the padded plaintext copy is zero after a failed encrypt too', async () => {
		const notAes = await crypto.subtle.importKey(
			'raw',
			counting(32),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		await expect(sealEnvelope(notAes, enc.encode('{}'), SALT)).rejects.toBeInstanceOf(Error);
		expect(seams.plaintexts).toHaveLength(1);
		expect(seams.plaintexts[0]?.every((b) => b === 0)).toBe(true);
	});

	it.each([
		['valid JSON', '{"hello":"world"}'],
		['not JSON', 'not json at all']
	])('the decrypted bytes are zero after decrypt (%s)', async (_name, inner) => {
		const env = await mustRead(await sealEnvelope(keyA, enc.encode(inner), SALT));
		await decryptEnvelope(env, keyA);
		expect(seams.decrypted).toHaveLength(1);
		const out = seams.decrypted[0];
		expect(out?.length).toBe(4096);
		expect(out?.every((b) => b === 0)).toBe(true);
	});

	it('two exports differ in salt, iv, check and data', async () => {
		const inner = enc.encode('{"same":"inner"}');
		const a = JSON.parse(await sealEnvelope(keyA, inner, newBackupSalt())) as Env;
		const b = JSON.parse(await sealEnvelope(keyA, inner, newBackupSalt())) as Env;
		expect(a.kdf['salt']).not.toBe(b.kdf['salt']);
		expect(a.cipher['iv']).not.toBe(b.cipher['iv']);
		expect(a['check']).not.toBe(b['check']);
		expect(a['data']).not.toBe(b['data']);
	});

	it('inner over the cap throws E_CONTENT_TOO_LARGE', async () => {
		const err = await sealEnvelope(
			keyA,
			new Uint8Array(MAX_PADDED_PLAINTEXT_BYTES + 1),
			SALT
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(BackupError);
		expect((err as BackupError).code).toBe('E_CONTENT_TOO_LARGE');
		expect(seams.plaintexts).toHaveLength(0);
	});

	it('a salt of the wrong length throws E_INTERNAL', async () => {
		await expect(sealEnvelope(keyA, enc.encode('{}'), counting(15))).rejects.toThrow('E_INTERNAL');
	});
});

describe('the freeze', () => {
	// A freeze of format v1: any change to the serializer, the AAD, the padding or the check fails this test. The two
	// pinned values were computed by an independent AES-256-GCM and SHA-256 in Node, so they also show the browser
	// path agrees with a second implementation. It is not a proof of the crypto itself.
	it('the whole envelope for a fixed key, salt, iv and inner is pinned', async () => {
		const key = await importAesKey(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
		const iv = counting(12, 0x20);
		vi.spyOn(crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => {
			a.set(iv);
			return a;
		}) as typeof crypto.getRandomValues);
		const text = await sealEnvelope(key, enc.encode('{"kat":"ask214"}'), counting(16));
		const check = fromB64((JSON.parse(text) as Env)['check'] as string);
		expect(hex(check)).toBe('1fff54421181700318e8072f36ed9377267bff456cd736d8bcf633e71be5806c');
		expect(hex(await sha256(enc.encode(text)))).toBe(
			'f7b14a772d0d7c3a79afa1e6c074e1e075fa0b009ac1ea5e6803b2200fffd296'
		);
		expect(enc.encode(text).length).toBe(5727);
	});
});

describe('no result carries file text', () => {
	// One canary: every refusal above is compared whole with toEqual, so a result that echoed file text would already
	// fail there. This row names the privacy rule itself, on the path that reads a field's value.
	it('a refused file with a canary in a field comes back as its code alone', async () => {
		const CANARY = 'CANARY-Zq7-private-note';
		const r = await readBackupFile(fileOf(edit(good, (e) => (e.kdf['alg'] = CANARY))));
		expect(r).toEqual({ ok: false, code: 'E_DAMAGED' });
		expect(JSON.stringify(r)).not.toContain('CANARY');
	});
});
