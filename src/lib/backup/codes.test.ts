import { describe, it, expect } from 'vitest';
import type { ErrorCode } from '../log/safelog';
import {
	BACKUP_CODES,
	DISPLAY_ONLY_BACKUP_CODES,
	LOGGED_BACKUP_CODES,
	BackupError,
	isBackupCode,
	toBackupCode,
	type BackupCode
} from './codes';

const EXPECTED_CODES = [
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
	'E_RESTORE_CANCELLED'
];

const STAGES = ['worker', 'crypto', 'content'] as const;
const STAGE_CODE = {
	worker: 'E_WORKER_FAILED',
	crypto: 'E_CRYPTO_FAILED',
	content: 'E_CONTENT_INVALID'
} as const;

describe('BACKUP_CODES', () => {
	it('holds exactly the listed codes, each E_-prefixed, no duplicates', () => {
		expect([...BACKUP_CODES]).toEqual(EXPECTED_CODES);
		expect(new Set(BACKUP_CODES).size).toBe(BACKUP_CODES.length);
		for (const code of BACKUP_CODES) expect(code.startsWith('E_')).toBe(true);
	});

	it('is frozen, so a caller cannot add a code at run time', () => {
		expect(Object.isFrozen(BACKUP_CODES)).toBe(true);
	});
});

describe('isBackupCode', () => {
	it('accepts every code and refuses others', () => {
		for (const code of EXPECTED_CODES) expect(isBackupCode(code)).toBe(true);
		const refused: unknown[] = [
			'E_TEST',
			'e_damaged',
			'E_DAMAGED ',
			'',
			1,
			null,
			undefined,
			{},
			{ code: 'E_DAMAGED' },
			['E_DAMAGED']
		];
		for (const value of refused) expect(isBackupCode(value)).toBe(false);
	});

	it('refuses the codes that live elsewhere', () => {
		for (const code of ['E_NOTE_TOO_LONG', 'E_NOTE_KEY', 'E_KEY_SHAPE', 'E_INTERNAL']) {
			expect(isBackupCode(code)).toBe(false);
		}
	});

	it('refuses an Object.prototype name', () => {
		for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
			expect(isBackupCode(name)).toBe(false);
		}
	});
});

describe('BackupError', () => {
	it('carries the code as both its code and its message', () => {
		const e = new BackupError('E_LOCKED');
		expect(e).toBeInstanceOf(Error);
		expect(e.name).toBe('BackupError');
		expect(e.code).toBe('E_LOCKED');
		expect(e.message).toBe('E_LOCKED');
	});
});

describe('toBackupCode', () => {
	it("keeps a BackupError's code in every stage", () => {
		for (const stage of STAGES) {
			for (const code of EXPECTED_CODES as BackupCode[]) {
				expect(toBackupCode(new BackupError(code), stage)).toBe(code);
			}
		}
	});

	const OTHER_THROWS: [string, () => unknown][] = [
		['RangeError', () => new RangeError('Array buffer allocation failed')],
		['TypeError', () => new TypeError('x is not a function')],
		['DOMException', () => new DOMException('quota', 'QuotaExceededError')],
		['a string', () => 'E_NO_MEMORY'],
		['undefined', () => undefined]
	];

	it.each(
		STAGES.flatMap((stage) => OTHER_THROWS.map(([name, make]) => [stage, name, make] as const))
	)("maps %s / %s to the stage's code", (stage, _name, make) => {
		expect(toBackupCode(make(), stage)).toBe(STAGE_CODE[stage]);
	});

	it('a RangeError is never NO_MEMORY on the main thread', () => {
		for (const stage of STAGES) {
			expect(toBackupCode(new RangeError('out of memory'), stage)).not.toBe('E_NO_MEMORY');
		}
	});

	it('an Error whose message is a backup code is not trusted', () => {
		for (const stage of STAGES) {
			expect(toBackupCode(new Error('E_NO_MEMORY'), stage)).toBe(STAGE_CODE[stage]);
			expect(toBackupCode(new Error('E_WRONG_PASSPHRASE'), stage)).toBe(STAGE_CODE[stage]);
		}
	});

	it('an object that only looks like a BackupError is not trusted', () => {
		const lookalike = { name: 'BackupError', code: 'E_NO_MEMORY', message: 'E_NO_MEMORY' };
		for (const stage of STAGES) {
			expect(toBackupCode(lookalike, stage)).toBe(STAGE_CODE[stage]);
		}
	});

	it('never reads message', () => {
		let reads = 0;
		const spy = {
			get message(): string {
				reads += 1;
				return 'a passphrase word';
			}
		};
		const err = new Error('x');
		Object.defineProperty(err, 'message', {
			get(): string {
				reads += 1;
				return 'a passphrase word';
			}
		});
		for (const stage of STAGES) {
			toBackupCode(spy, stage);
			toBackupCode(err, stage);
		}
		expect(reads).toBe(0);
	});
});

describe('logged and display-only codes', () => {
	it('every code is logged or display-only, never both', () => {
		const logged: readonly string[] = LOGGED_BACKUP_CODES;
		const display: readonly string[] = DISPLAY_ONLY_BACKUP_CODES;
		expect(logged).toEqual(['E_EXPORT_SELF_INVALID']);
		for (const code of logged) expect(display).not.toContain(code);
		expect([...logged, ...display].sort()).toEqual([...BACKUP_CODES].sort());
	});

	it('the logged codes are members of the safelog union', () => {
		const asErrorCodes: readonly ErrorCode[] = LOGGED_BACKUP_CODES;
		expect(asErrorCodes.length).toBe(1);
	});
});
