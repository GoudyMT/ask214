import { aesGcmEncrypt, aesGcmDecrypt, AesGcmAuthError } from '../crypto/aes-gcm';
import { buildBackupAad } from './aad';
import { BackupError } from './codes';
import {
	MAX_PADDED_PLAINTEXT_BYTES,
	MAX_CIPHERTEXT_BYTES,
	MAX_FILE_BYTES,
	PAD_BLOCK_BYTES
} from './caps';
import { serializeEnvelope } from './envelope-json';
import { KDF_V1, SALT_BYTES, IV_BYTES, CHECK_BYTES } from './kdf-params';

/** What a good backup file holds once read: the bytes the key step and the decrypt step need. */
export type ParsedEnvelope = {
	salt: Uint8Array<ArrayBuffer>;
	iv: Uint8Array<ArrayBuffer>;
	ct: Uint8Array<ArrayBuffer>;
};

export type ParseResult =
	| { ok: true; envelope: ParsedEnvelope }
	| { ok: false; code: 'E_FILE_TOO_LARGE' | 'E_NOT_BACKUP' | 'E_NEWER_VERSION' | 'E_DAMAGED' };

export type DecryptResult =
	| { ok: true; inner: unknown }
	| { ok: false; code: 'E_WRONG_PASSPHRASE' | 'E_CRYPTO_FAILED' | 'E_CONTENT_INVALID' };

// Standard alphabet then at most two "=" pads. No whitespace, no URL-safe alphabet. The length must also be a multiple
// of four, which together with this pattern is exactly "groups of four, then an optional xx== or xxx= group". Written
// as one flat character loop because a repeated four-character group overflows the regex engine's stack on a
// multi-megabyte `data` field.
const B64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

// Padding byte: a space is valid JSON whitespace, so the padded plaintext still parses to the same value.
const PAD_BYTE = 0x20;

// Smallest valid ciphertext: one pad block plus the 16-byte GCM tag.
const MIN_CIPHERTEXT_BYTES = PAD_BLOCK_BYTES + 16;

function b64Encode(bytes: Uint8Array): string {
	// Chunked: one `String.fromCharCode(...bytes)` on megabytes overflows the call stack.
	const CHUNK = 0x8000;
	let bin = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

/** Strict decode: null unless the text is canonical base64, i.e. re-encoding the decoded bytes gives the same text. */
function b64DecodeStrict(text: string): Uint8Array<ArrayBuffer> | null {
	if (text.length % 4 !== 0 || !B64_PATTERN.test(text)) return null;
	let bin: string;
	try {
		bin = atob(text);
	} catch {
		return null;
	}
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
	return b64Encode(out) === text ? out : null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
	return true;
}

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Sorted-key compare. An own "__proto__" key made by JSON.parse is listed by Object.keys, so it fails here.
function hasExactKeys(o: Plain, sortedKeys: readonly string[]): boolean {
	const keys = Object.keys(o).sort();
	return keys.length === sortedKeys.length && keys.every((k, i) => k === sortedKeys[i]);
}

function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
	return crypto.subtle.digest('SHA-256', bytes);
}

function joinBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

/** A fresh random Argon2id salt; every export gets its own. */
export function newBackupSalt(): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/**
 * Encrypts `inner` (UTF-8 JSON) into the backup file text. The plaintext is padded with spaces to a multiple of the
 * pad block on a COPY, which is zeroed as soon as the encryption settles; the caller owns `inner` and zeroes it. The
 * `check` field is SHA-256 over the AAD bytes then the ciphertext-with-tag bytes: it is not keyed and not derived from
 * the passphrase, so it only tells a damaged file from a wrong passphrase and is no security control.
 */
export async function sealEnvelope(
	key: CryptoKey,
	inner: Uint8Array,
	salt: Uint8Array
): Promise<string> {
	// The export flow checks first and names the task; this is the guard behind it.
	if (inner.length > MAX_PADDED_PLAINTEXT_BYTES) throw new BackupError('E_CONTENT_TOO_LARGE');
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const aad = new TextEncoder().encode(buildBackupAad(salt, iv));
	const paddedLength = Math.max(
		PAD_BLOCK_BYTES,
		Math.ceil(inner.length / PAD_BLOCK_BYTES) * PAD_BLOCK_BYTES
	);
	const padded = new Uint8Array(paddedLength).fill(PAD_BYTE);
	padded.set(inner);
	let ct: Uint8Array<ArrayBuffer>;
	try {
		ct = await aesGcmEncrypt(key, iv, aad, padded);
	} finally {
		padded.fill(0);
	}
	const check = new Uint8Array(await sha256(joinBytes(aad, ct)));
	return serializeEnvelope({
		salt: b64Encode(salt),
		iv: b64Encode(iv),
		check: b64Encode(check),
		data: b64Encode(ct)
	});
}

const refuse = <C extends Extract<ParseResult, { ok: false }>['code']>(code: C) =>
	({ ok: false, code }) as const;

/**
 * Reads a backup file and refuses anything that is not exactly our shape, with the reason, before any key work. Each
 * refusal is a returned code that holds no part of the file. The steps run in a fixed order: size, bytes, text, JSON,
 * format, version (so a newer file with new keys says "update"), exact keys, key-derivation numbers, base64 and
 * lengths, the ciphertext bound, then the check.
 */
export async function readBackupFile(file: File): Promise<ParseResult> {
	if (file.size > MAX_FILE_BYTES) return refuse('E_FILE_TOO_LARGE');
	// A file whose reported size understates its bytes still cannot get more than the bound into memory.
	const buf = await file.slice(0, MAX_FILE_BYTES + 1).arrayBuffer();
	if (buf.byteLength > MAX_FILE_BYTES) return refuse('E_FILE_TOO_LARGE');

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
	} catch {
		return refuse('E_NOT_BACKUP');
	}
	if (!isPlainObject(parsed)) return refuse('E_NOT_BACKUP');
	if (!Object.hasOwn(parsed, 'format') || parsed['format'] !== 'ask214-backup') {
		return refuse('E_NOT_BACKUP');
	}

	const version = Object.hasOwn(parsed, 'version') ? parsed['version'] : undefined;
	if (typeof version === 'number' && Number.isInteger(version) && version > 1) {
		return refuse('E_NEWER_VERSION');
	}
	if (version !== 1) return refuse('E_DAMAGED');

	if (!hasExactKeys(parsed, ['check', 'cipher', 'data', 'format', 'kdf', 'version'])) {
		return refuse('E_DAMAGED');
	}
	const kdf = parsed['kdf'];
	const cipher = parsed['cipher'];
	if (!isPlainObject(kdf) || !hasExactKeys(kdf, ['alg', 'm', 'p', 'salt', 't', 'v'])) {
		return refuse('E_DAMAGED');
	}
	if (!isPlainObject(cipher) || !hasExactKeys(cipher, ['alg', 'iv'])) return refuse('E_DAMAGED');

	if (kdf['alg'] !== 'argon2id' || cipher['alg'] !== 'AES-GCM') return refuse('E_DAMAGED');
	// typeof and === together: the string "131072" is not the number 131072.
	for (const name of ['v', 'm', 't', 'p'] as const) {
		const value = kdf[name];
		if (typeof value !== 'number' || value !== KDF_V1[name]) return refuse('E_DAMAGED');
	}

	const saltText = kdf['salt'];
	const ivText = cipher['iv'];
	const checkText = parsed['check'];
	const dataText = parsed['data'];
	if (
		typeof saltText !== 'string' ||
		typeof ivText !== 'string' ||
		typeof checkText !== 'string' ||
		typeof dataText !== 'string'
	) {
		return refuse('E_DAMAGED');
	}
	const salt = b64DecodeStrict(saltText);
	const iv = b64DecodeStrict(ivText);
	const check = b64DecodeStrict(checkText);
	const ct = b64DecodeStrict(dataText);
	if (salt === null || iv === null || check === null || ct === null) return refuse('E_DAMAGED');
	if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || check.length !== CHECK_BYTES) {
		return refuse('E_DAMAGED');
	}

	// A file that fits the size bound can still carry more ciphertext than any export makes.
	if (ct.length > MAX_CIPHERTEXT_BYTES) return refuse('E_FILE_TOO_LARGE');
	if (ct.length < MIN_CIPHERTEXT_BYTES || (ct.length - 16) % PAD_BLOCK_BYTES !== 0) {
		return refuse('E_DAMAGED');
	}

	const aad = new TextEncoder().encode(buildBackupAad(salt, iv));
	if (!sameBytes(new Uint8Array(await sha256(joinBytes(aad, ct))), check)) {
		return refuse('E_DAMAGED');
	}

	// A fresh object, each field read by name: nothing of the parsed file rides along.
	return { ok: true, envelope: { salt, iv, ct } };
}

/**
 * Decrypts a read envelope. The check already matched, so the bytes are intact: an authentication failure here means
 * the key (the passphrase) is wrong. The decrypted bytes are zeroed on every path.
 */
export async function decryptEnvelope(env: ParsedEnvelope, key: CryptoKey): Promise<DecryptResult> {
	const aad = new TextEncoder().encode(buildBackupAad(env.salt, env.iv));
	let plain: Uint8Array<ArrayBuffer> | undefined;
	try {
		try {
			plain = await aesGcmDecrypt(key, env.iv, aad, env.ct);
		} catch (e) {
			return {
				ok: false,
				code: e instanceof AesGcmAuthError ? 'E_WRONG_PASSPHRASE' : 'E_CRYPTO_FAILED'
			};
		}
		try {
			return {
				ok: true,
				inner: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))
			};
		} catch {
			return { ok: false, code: 'E_CONTENT_INVALID' };
		}
	} finally {
		plain?.fill(0);
	}
}
