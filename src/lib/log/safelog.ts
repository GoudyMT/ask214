/**
 * Sanctioned log sink. The argument TYPE prevents raw Error / error.message
 * from passing TypeScript compilation; the mtc/safelog-no-error ESLint rule
 * provides a redundant lint-time check.
 *
 * The ESLint no-console rule (error) bans direct console usage in the app runtime, so all
 * diagnostic output goes through this sink - a raw console could leak decrypted PII.
 *
 * Ring buffer is in-memory only (never persisted; no PII storage); sized 64
 * entries. No public accessor in production - getDiagnosticsForTest is gated
 * by a build-time flag.
 */
export type ErrorCode =
	| 'E_EAOS_FORMAT'
	| 'E_EAOS_YEAR_RANGE'
	| 'E_EAOS_MONTH'
	| 'E_EAOS_DAY'
	| 'E_KEYSTORE_HMAC_MISMATCH'
	| 'E_KEYSTORE_TAMPER'
	| 'E_SIDECAR_TAMPER'
	| 'E_LOCK_TIMEOUT'
	| 'E_OCC_CONFLICT'
	| 'E_BROADCAST_REPLAY'
	| 'E_BROADCAST_AUTH'
	| 'E_JOURNAL_RECOVERY'
	| 'E_KDF_CALIBRATION'
	| 'E_PASSPHRASE_WEAK'
	| 'E_UNSUPPORTED_BROWSER'
	| 'E_INIT_FAILED'
	| 'E_CLOCK_BACKWARD'
	| 'E_TIMEOUT'
	| 'E_TEST'; // dev/test only; stripped in prod build via type-check

export type SafeLogEntry = {
	code: ErrorCode;
	fields?: Record<string, number | boolean | ErrorCode>;
	ts: number;
};

export const RING_BUFFER_SIZE = 64;

const buffer: SafeLogEntry[] = [];

export function safeLog(entry: { code: ErrorCode; fields?: SafeLogEntry['fields'] }): void {
	buffer.push({ code: entry.code, fields: entry.fields, ts: Date.now() });
	if (buffer.length > RING_BUFFER_SIZE) {
		buffer.splice(0, buffer.length - RING_BUFFER_SIZE);
	}
}

/**
 * TEST-ONLY accessor. Production builds remove this via type-check + ESLint
 * (consumer-side: importing this in non-test code is banned via
 * no-restricted-imports). Do NOT expose a public diagnostics API.
 */
export function getDiagnosticsForTest(): SafeLogEntry[] {
	return buffer;
}
