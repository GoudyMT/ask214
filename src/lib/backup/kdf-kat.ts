/**
 * Known answers that pin the Argon2id library to the exact maths of the reference algorithm, so a library update that
 * changed one bit of the key fails the build instead of locking people out of their old backups.
 *
 * Where the answers come from: `hash-wasm` 4.12.0, a WebAssembly build of the Argon2 reference C code and so
 * independent of `@noble/hashes`. It is not a dependency of this project. Run under Node 22.22.3 on 2026-10-16 as
 * `argon2id({ password, salt, iterations, memorySize, parallelism, hashLength: 32 })`, with `password` the bytes of
 * `KAT_PASSWORD`, `salt` the bytes of `KAT_SALT`, and `iterations`, `memorySize` and `parallelism` the t, m and p of
 * the tuple named beside each answer.
 *
 * Where each answer is checked:
 * - `KAT_ARGON2_HEX` uses the production tuple (`KAT_ARGON2_TUPLE`, equal to `KDF_V1`). It is too slow for the unit
 *   suite (about 1.4 s in noble, close to the 5 s test limit on a slow runner), so the unit suite never runs it.
 *   It is checked through the built, served worker by tests/e2e/backup-kdf.e2e.ts.
 * - `KAT_SMALL_ARGON2_HEX` (t 1, m 64, p 1) and the RFC 9106 vector run in every unit run.
 *
 * The password is six words of the backup list, because the worker refuses any other word before it runs Argon2id; a
 * test keeps them on the list so a list change fails loudly instead of moving the answer. This module imports nothing
 * at run time and nothing in the app imports it.
 *
 * The `KAT_PIN_*` answers pin the PIN step of the key worker (`derive-pin`): the PIN `KAT_PIN` and `KAT_SALT` through
 * Argon2id, then HKDF-SHA256 with the same salt into a MAC key and a key-wrapping key. They were computed on 2026-10-25
 * by the build lead, outside this repository's code: `argon2-cffi` 23.1.0 for Argon2id (the same tool reproduced
 * `KAT_ARGON2_HEX` exactly as a control), and Node 22's `hkdfSync`, `createHmac` and `id-aes256-wrap` for the rest.
 * Each tuple has two proofs of the keys: the HMAC-SHA-256 of `KAT_PIN_MAC_MESSAGE` under the MAC key, and the AES-KW
 * (RFC 3394) wrap of `KAT_PIN_WRAPPED_KEY` under the wrapping key. The full tuple is checked through the built, served
 * worker by tests/e2e/backup-kdf.e2e.ts; the small tuple runs in the unit suite through the real noble Argon2id.
 */

export const KAT_PASSWORD = 'acorn harbor cable mango velvet zebra';

/** Bytes 0x00 to 0x0f. */
export const KAT_SALT: Uint8Array<ArrayBuffer> = Uint8Array.from({ length: 16 }, (_, i) => i);

/** The production tuple of backup format v1: Argon2id version 0x13, 128 MiB (m is in KiB), 4 passes, 2 lanes. */
export const KAT_ARGON2_TUPLE = Object.freeze({ v: 0x13, m: 131_072, t: 4, p: 2, dkLen: 32 });

/** Argon2id of `KAT_PASSWORD` and `KAT_SALT` under `KAT_ARGON2_TUPLE`, 32 bytes. */
export const KAT_ARGON2_HEX = 'a076b5f49138ede8560e8548ebbed98462969f2fd5c7522b636466dd9da0ac1e';

/** Argon2id of `KAT_PASSWORD` and `KAT_SALT` at t 1, m 64, p 1, version 0x13, 32 bytes. */
export const KAT_SMALL_ARGON2_HEX =
	'3549112c786ab81b6391d175fa8227c5c4caf1fea3830cce9efdea8849a0884d';

/** The PIN of the `KAT_PIN_*` answers, as typed. */
export const KAT_PIN = '135790';

/** The message whose HMAC-SHA-256 under the derived MAC key is the MAC proof. */
export const KAT_PIN_MAC_MESSAGE = 'kat-pin-mac';

/** The 32 bytes 0x80 to 0x9f that the KEK proof wraps. */
export const KAT_PIN_WRAPPED_KEY: Uint8Array<ArrayBuffer> = Uint8Array.from(
	{ length: 32 },
	(_, i) => 0x80 + i
);

/** `KAT_PIN` and `KAT_SALT` under `KAT_ARGON2_TUPLE` (t 4, m 131072, p 2): Argon2id output, MAC proof, wrap proof. */
export const KAT_PIN_FULL = Object.freeze({
	argon2Hex: '89cf3e290ff216d52fadefa4001f637fea323784904a04ac04d7e0d9ba67432b',
	macHex: '9e6c0e11c5a4ec98fc71cde35d16b49e1e85d606a1fcd6af8eaeadbe224f2dcb',
	wrapHex: '5571be5486f7eb6cae2aa306d8d0746cdf5fbddeaf5e5886430bd85b56fa5a04193c446daf3bbfbe'
});

/** `KAT_PIN` and `KAT_SALT` at t 1, m 64, p 1: Argon2id output, MAC proof, wrap proof. */
export const KAT_PIN_SMALL = Object.freeze({
	argon2Hex: '57c5f073fae044fbbc5e1aac275d3e23f2ab5697ae9e1fc1d05727e06d4917cf',
	macHex: '0448ba177e4f30a074aaeaaa45cebf5c3944381cfb2402b6b14a09956c29247d',
	wrapHex: 'c6834caf238069ac34c24b1530fd1980e107246a002650529261bbd1d3cb21eb442f3a1fb13db439'
});

/**
 * RFC 9106 section 5.3 (Argon2id): password 32 bytes of 0x01, salt 16 bytes of 0x02, secret 8 bytes of 0x03,
 * associated data 12 bytes of 0x04, t 3, m 32, p 4, version 0x13, tag 32 bytes. Noble calls the secret `key` and the
 * associated data `personalization`.
 */
export const RFC9106_ARGON2ID = Object.freeze({
	password: new Uint8Array(32).fill(0x01),
	salt: new Uint8Array(16).fill(0x02),
	secret: new Uint8Array(8).fill(0x03),
	associatedData: new Uint8Array(12).fill(0x04),
	t: 3,
	m: 32,
	p: 4,
	version: 0x13,
	dkLen: 32,
	tagHex: '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659'
});
