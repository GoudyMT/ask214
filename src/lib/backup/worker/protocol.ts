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

/** What the worker may answer. A code and a position never carry a word, only where it stood. */
export type FromWorker =
	| { type: 'words'; words: string[] }
	| { type: 'progress'; percent: number }
	| { type: 'key'; key: CryptoKey }
	| { type: 'error'; code: BackupCode; position?: 1 | 2 | 3 | 4 | 5 | 6 };

const SALT_LENGTH = 16;
const GENERATE_KEYS = 'op';
const DERIVE_KEYS = 'op,pass,purpose,salt';

/**
 * The exact request shapes and nothing else: own keys, value types and the salt length. Anything off is a bug on the
 * page or a stray message, so the worker refuses it before it reads a byte of `pass`.
 */
export function isWorkerRequest(value: unknown): value is WorkerRequest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const keys = Object.keys(value).sort().join(',');
	const record = value as Record<string, unknown>;
	if (record.op === 'generate') return keys === GENERATE_KEYS;
	if (record.op !== 'derive' || keys !== DERIVE_KEYS) return false;
	return (
		(record.purpose === 'export' || record.purpose === 'restore') &&
		record.pass instanceof ArrayBuffer &&
		record.salt instanceof Uint8Array &&
		record.salt.length === SALT_LENGTH
	);
}
