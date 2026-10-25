import { isBackupCode } from '../codes';
import type { BackupCode } from '../codes';

/** What the page may send. `pass` is transferred, so the page's own copy is detached the moment it is posted. */
export type WorkerRequest =
	| { op: 'generate' }
	| {
			op: 'derive';
			purpose: 'export' | 'restore';
			pass: ArrayBuffer;
			salt: Uint8Array<ArrayBuffer>;
	  };

/**
 * The app lock's PIN request: a 4 to 6 digit PIN and the 16-byte PIN salt, which the worker turns into the lock's two
 * keys at the backup's Argon2id settings. `pin` is transferred like `pass`. It is its own type, not a member of
 * WorkerRequest, because the backup session and its test doubles take WorkerRequest and read `pass` from every derive.
 */
export type PinRequest = { op: 'derive-pin'; pin: ArrayBuffer; salt: Uint8Array<ArrayBuffer> };

/** What the worker may answer. A code and a position never carry a word, only where it stood. */
export type FromWorker =
	| { type: 'words'; words: string[] }
	| { type: 'progress'; percent: number }
	| { type: 'key'; key: CryptoKey }
	| { type: 'pin-keys'; macKey: CryptoKey; kek: CryptoKey }
	| { type: 'error'; code: BackupCode; position?: 1 | 2 | 3 | 4 | 5 | 6 };

const SALT_LENGTH = 16;
const WORD_COUNT = 6;
const PLAIN_WORD = /^[a-z]+$/;
const GENERATE_KEYS = 'op';
const DERIVE_KEYS = 'op,pass,purpose,salt';
const DERIVE_PIN_KEYS = 'op,pin,salt';
const PIN_MIN_BYTES = 4;
const PIN_MAX_BYTES = 6;
const ASCII_ZERO = 0x30;
const ASCII_NINE = 0x39;

function isPinBuffer(value: unknown): value is ArrayBuffer {
	if (!(value instanceof ArrayBuffer)) return false;
	if (value.byteLength < PIN_MIN_BYTES || value.byteLength > PIN_MAX_BYTES) return false;
	return new Uint8Array(value).every((byte) => byte >= ASCII_ZERO && byte <= ASCII_NINE);
}

/**
 * The exact request shapes and nothing else: own keys, value types and the salt length. Anything off is a bug on the
 * page or a stray message, so the worker refuses it before it reads a byte of `pass`.
 */
export function isWorkerRequest(value: unknown): value is WorkerRequest | PinRequest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const keys = Object.keys(value).sort().join(',');
	const record = value as Record<string, unknown>;
	if (record.op === 'generate') return keys === GENERATE_KEYS;
	if (record.op === 'derive-pin') {
		return (
			keys === DERIVE_PIN_KEYS &&
			isPinBuffer(record.pin) &&
			record.salt instanceof Uint8Array &&
			record.salt.length === SALT_LENGTH
		);
	}
	if (record.op !== 'derive' || keys !== DERIVE_KEYS) return false;
	return (
		(record.purpose === 'export' || record.purpose === 'restore') &&
		record.pass instanceof ArrayBuffer &&
		record.salt instanceof Uint8Array &&
		record.salt.length === SALT_LENGTH
	);
}

function isInteger(value: unknown, min: number, max: number): boolean {
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * The exact answer shapes, for the page to check what came back from another thread before it reads any field. Own
 * keys are matched exactly, so a stray field (an error's text, an echoed word) makes an answer invalid instead of
 * riding along.
 */
export function isWorkerAnswer(value: unknown): value is FromWorker {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const keys = Object.keys(value).sort().join(',');
	const record = value as Record<string, unknown>;
	switch (record.type) {
		case 'words':
			return (
				keys === 'type,words' &&
				Array.isArray(record.words) &&
				record.words.length === WORD_COUNT &&
				record.words.every((word) => typeof word === 'string' && PLAIN_WORD.test(word))
			);
		case 'progress':
			return keys === 'percent,type' && isInteger(record.percent, 0, 100);
		case 'key':
			return (
				keys === 'key,type' && typeof CryptoKey !== 'undefined' && record.key instanceof CryptoKey
			);
		case 'pin-keys':
			return (
				keys === 'kek,macKey,type' &&
				typeof CryptoKey !== 'undefined' &&
				record.macKey instanceof CryptoKey &&
				record.kek instanceof CryptoKey
			);
		case 'error':
			if (keys === 'code,type') return isBackupCode(record.code);
			return (
				keys === 'code,position,type' &&
				isBackupCode(record.code) &&
				isInteger(record.position, 1, 6)
			);
		default:
			return false;
	}
}
