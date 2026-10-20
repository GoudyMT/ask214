/**
 * Every way a backup can stop, as an opaque code. The shipped store codes (E_NOTE_TOO_LONG, E_NOTE_KEY, E_KEY_SHAPE)
 * keep their own homes and messages and are not listed here.
 */
export const BACKUP_CODES = Object.freeze([
	'E_FILE_TOO_LARGE',
	'E_NOT_BACKUP',
	'E_NEWER_VERSION',
	'E_DAMAGED',
	'E_WRONG_PASSPHRASE',
	'E_NO_MEMORY',
	'E_WORKER_FAILED',
	'E_CRYPTO_FAILED',
	'E_CONTENT_INVALID',
	'E_LOCKED',
	'E_CODE_UNAVAILABLE',
	'E_APP_UPDATED',
	'E_SNAPSHOT_FAILED',
	'E_SAVE_FAILED',
	'E_WRITE_FAILED',
	'E_CONTENT_TOO_LARGE',
	'E_EXPORT_SELF_INVALID',
	'E_WORD_COUNT',
	'E_NOT_LETTERS',
	'E_NOT_A_WORD',
	'E_TYPE_BACK_MISMATCH',
	'E_TOOK_TOO_LONG',
	'E_LEFT_APP',
	'E_BACKUP_UNAVAILABLE',
	'E_RESTORE_DEVICE_MOVED',
	'E_RESTORE_DEVICE_CHANGED',
	'E_RESTORE_DEVICE_DAMAGED',
	'E_RESTORE_CANCELLED',
	'E_LOCKED_ELSEWHERE',
	'E_EXPORT_CANCELLED'
] as const);

export type BackupCode = (typeof BACKUP_CODES)[number];

const CODE_SET: ReadonlySet<unknown> = new Set(BACKUP_CODES);

/** For a code a worker posts back: that is data from another thread, so its shape is checked, not trusted. */
export function isBackupCode(value: unknown): value is BackupCode {
	return CODE_SET.has(value);
}

/** A backup step's failure. The message IS the code and never any input, so nothing it carries can hold a secret. */
export class BackupError extends Error {
	readonly code: BackupCode;

	constructor(code: BackupCode) {
		super(code);
		this.name = 'BackupError';
		this.code = code;
	}
}

const STAGE_CODE = {
	worker: 'E_WORKER_FAILED',
	crypto: 'E_CRYPTO_FAILED',
	content: 'E_CONTENT_INVALID'
} as const satisfies Record<'worker' | 'crypto' | 'content', BackupCode>;

/**
 * The code to show for anything that was thrown. A BackupError gives its own code; every other throw gives the code of
 * the stage that caught it. It never reads `e.message`, because an error's text can hold a passphrase word or a byte of
 * the file, and it never returns E_NO_MEMORY: only the key worker's own catch around Argon2id proves low memory, and
 * it posts E_NO_MEMORY itself. A RangeError on the main thread is not proof, and a plain Error whose message
 * happens to be a code is not trusted either.
 */
export function toBackupCode(e: unknown, stage: 'worker' | 'crypto' | 'content'): BackupCode {
	if (e instanceof BackupError) return e.code;
	return STAGE_CODE[stage];
}
