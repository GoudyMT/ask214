/**
 * The values that pin the golden backup, `v1-1.ask214backup`: one file made by release 1.8.0 under envelope version 1
 * and inner `backupSchema` 1.
 *
 * THE RULE. This file must restore, into a fresh device, in every release that ever ships. A person's backup made by
 * this release has to open in every later one. A change that stops it restoring (a tighter validator, a store
 * `schemaVersion`, a field that starts or stops being written, a new key derivation or cipher setting) ships a
 * migration for old files in the same change; it never edits, regenerates or replaces this file, and it never edits a
 * value below to make a test pass. A changed byte is a format event, not a refresh.
 *
 * HOW IT WAS MADE, once. A throwaway script (not kept) took the records below, wrote the profile's dates as the codec
 * does (base64 of the ISO day), checked the inner with `validateInner`, derived the AES key from `GOLDEN_ARGON2_HEX`
 * with HKDF-SHA-256 (salt `GOLDEN_SALT`, info `HKDF_INFO_V1`) through WebCrypto directly, and sealed it with the
 * shipped `sealEnvelope` and that salt. The text was written as it came out, with no trailing newline. Every value is
 * made up; none is a real person's.
 *
 * `GOLDEN_ARGON2_HEX` is Argon2id (version 0x13, t 4, m 131072, p 2, 32 bytes) of the password's UTF-8 bytes and the
 * salt, computed by hash-wasm 4.12.0 and confirmed by @noble/hashes 2.4.0. The unit test stands in for the slow key
 * step with this value; the browser test that runs the real worker proves the same key.
 *
 * This module imports nothing, so no change to app code can move a pinned value.
 */

/** Six words from the v1 word list. */
export const GOLDEN_PASSWORD = 'bamboo copper harvest lantern oxygen thimble';

/** The Argon2id salt, and the HKDF salt: the bytes 0x10 to 0x1f. */
export const GOLDEN_SALT: Uint8Array<ArrayBuffer> = Uint8Array.from(
	{ length: 16 },
	(_, i) => 0x10 + i
);

export const GOLDEN_ARGON2_HEX = '7bc54241a22e08156776840ffbde06b7bd17fe4bc5e09e443c79b3341af54f5e';

/** SHA-256 of the committed file's bytes. */
export const GOLDEN_SHA256 = 'b6f973c49f2b5b5ff0e8ff1ae65db4fae4ef4758f46bf62bf8f7a6daaf44f893';

/** The inner's `createdAt` (2026-10-16T12:00:00Z) and `appVersion`. */
export const GOLDEN_CREATED_AT = 1792152000000;
export const GOLDEN_APP_VERSION = '1.8.0';

// Emoji (a surrogate pair), Hebrew and Arabic text, a right-to-left override, a quote and a backslash: everything a
// note's JSON text has to escape or keep apart. Built from code units so this file stays ASCII.
const MIXED_NOTE = [
	'call ',
	String.fromCharCode(0xd83d, 0xde00),
	' ',
	String.fromCharCode(0x5e9, 0x5dc, 0x5d5, 0x5dd),
	' ',
	String.fromCharCode(0x645, 0x631, 0x62d, 0x628, 0x627),
	' ',
	String.fromCharCode(0x202e),
	' "quoted" back',
	String.fromCharCode(0x5c),
	'slash'
].join('');

/**
 * The content a restore must give a fresh device, in the form each store hands out once loaded: dates as ISO text.
 * The profile leaves out what the device composes itself (its generation, clock mark and backup mark), and the
 * calendar leaves out the list of events handed to a phone, which a file never carries.
 */
export const GOLDEN_EXPECTED = {
	profile: {
		schemaVersion: 1,
		setupIntent: 'completed',
		setupIntentChangedAt: 1791374400000,
		eaos: '2027-06-30',
		skillbridgeStart: '2027-03-22',
		terminalLeaveStart: '2027-04-26'
	},
	timeline: {
		schemaVersion: 1,
		tasks: {
			'va-gov-account': { status: 'done' },
			'login-gov-account': { status: 'done', notes: 'Used the second email address' },
			'update-sgli': { status: 'skipped' },
			'tap-course': { status: 'snoozed', snoozeUntil: '2027-01-15', notes: MIXED_NOTE },
			'job-search': { notes: 'Ask the career office about the resume workshop' },
			'will-poa': { status: 'snoozed' },
			'skillbridge-plan': { status: 'snoozed', snoozeUntil: '2027-02-01' }
		}
	},
	calendar: {
		schemaVersion: 1,
		exclusions: { taskIds: ['will-poa', 'job-search'], categories: ['finance', 'career'] },
		card: { dismissedAt: 1791892800000, dismissCount: 2 }
	}
} as const;
