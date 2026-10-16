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
 *   suite (about 1.4 s in noble, close to the 5 s test limit on a slow runner), so it is checked through the built
 *   worker in a browser test.
 * - `KAT_SMALL_ARGON2_HEX` (t 1, m 64, p 1) and the RFC 9106 vector run in every unit run.
 *
 * The password is six words of the backup list, because the worker refuses any other word before it runs Argon2id; a
 * test keeps them on the list so a list change fails loudly instead of moving the answer. This module imports nothing
 * at run time and nothing in the app imports it.
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
