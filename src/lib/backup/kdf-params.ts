/**
 * The key-derivation settings of backup format v1: Argon2id version 19 (0x13), 128 MiB of memory (`m` is in KiB),
 * 4 passes, 2 lanes, 32 output bytes. They are fixed for the format: a file written under other numbers is refused
 * unread, and a new tuple ships only as format version 2. Frozen so no caller can tune them at runtime.
 */
export const KDF_V1 = Object.freeze({ v: 0x13, m: 131_072, t: 4, p: 2, dkLen: 32 });

/** HKDF-SHA256 label that turns the Argon2id output into the AES key; it names the purpose and the format version. */
export const HKDF_INFO_V1 = 'ask214-backup-v1/aes-gcm-256';

/** Random Argon2id salt, new for every export. */
export const SALT_BYTES = 16;

/** AES-GCM nonce size; GCM is built for 12 bytes. */
export const IV_BYTES = 12;

/** SHA-256 output size, the length of the envelope's `check` field. */
export const CHECK_BYTES = 32;
