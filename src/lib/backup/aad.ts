import { KDF_V1, HKDF_INFO_V1, SALT_BYTES, IV_BYTES } from './kdf-params';

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The additional authenticated data for a backup's AES-GCM encryption, as lowercase text. It spells out every
 * setting the file carries (the key derivation numbers and salt, the key label, the cipher and its nonce), so the
 * AAD binds the ciphertext to every setting written in the file: a file whose settings were edited cannot decrypt,
 * because the reader rebuilds this text from the edited file and the tag no longer matches.
 *
 * A wrong salt or nonce length is a bug in the caller, never file input (the reader checks lengths first).
 */
export function buildBackupAad(salt: Uint8Array, iv: Uint8Array): string {
	if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) throw new Error('E_INTERNAL');
	return [
		'ask214-backup',
		'v1',
		`argon2id;v=${KDF_V1.v};m=${KDF_V1.m};t=${KDF_V1.t};p=${KDF_V1.p};len=${KDF_V1.dkLen};salt=${toHex(salt)}`,
		`hkdf-sha256;info=${HKDF_INFO_V1}`,
		`aes-256-gcm;iv=${toHex(iv)};tag=128`
	].join('|');
}
