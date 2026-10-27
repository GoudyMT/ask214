import { hmacSign, hmacVerify } from '../crypto/hmac';

/**
 * Single HMAC-authenticated keystore record - all security-sensitive crypto
 * metadata in one place; tampering any covered field invalidates the record
 * HMAC at boot. v1.0 ships local mode only (passphrase modes deferred to v1.1).
 *
 * CryptoKey refs are stored via IDB structured-clone (extractable:false) and are
 * not serialized into the canonical form (SubtleCrypto does not expose key bytes).
 */
export type KeystoreRecordV1 = {
	v: 1;
	mode: 'local';
	keystoreGeneration: number;
	epoch: number; // forward-compat constant 0 in v1.0 (no rotation)
	ivCounter: number; // warn 2^28, hard-stop 2^32 - 2^24
	installUuid: Uint8Array; // 16 bytes
	dataKeyRef: CryptoKey; // AES-GCM-256, extractable:false
	hmacKeyRef: CryptoKey; // HMAC-SHA-256, extractable:false (domain-separation prefixes)
	recordHmac?: ArrayBuffer;
};

export type KeystoreRecordLocal = KeystoreRecordV1;

/** The Argon2id settings a PIN row was made under; the PIN step checks them against the app's own before any derive. */
export type KdfTuple = Readonly<{ v: number; m: number; t: number; p: number; dkLen: number }>;

/** A row in PIN mode holds no key handle: only the salt, the KDF tuple and the two keys wrapped under the PIN's key. */
export type KeystoreRecordPin = {
	v: 1;
	mode: 'pin';
	keystoreGeneration: number;
	epoch: number;
	ivCounter: number;
	installUuid: Uint8Array;
	kdf: KdfTuple;
	salt: Uint8Array; // 16 bytes, new for every turn-on and every change
	bag: Uint8Array; // [0, 40) the AES-GCM data key and [40, 80) the HMAC key, each AES-KW wrapped under the PIN key
	recordHmac?: ArrayBuffer;
};

export type KeystoreRecord = KeystoreRecordLocal | KeystoreRecordPin;

export const PIN_SALT_BYTES = 16;
export const PIN_BAG_BYTES = 80;

type LocalCanonicalInput = Omit<KeystoreRecordLocal, 'dataKeyRef' | 'hmacKeyRef' | 'recordHmac'>;
type PinCanonicalInput = Omit<KeystoreRecordPin, 'recordHmac'>;

/**
 * Subset of a record the record HMAC and the key identity are built from.
 * Excludes ivCounter (operational), recordHmac (self-reference), and the
 * CryptoKey refs (unserializable). The key identity's text never reads `mode`:
 * it always writes the literal `mode=local`. Only a PIN row's own MAC reads it.
 */
export type KeystoreCanonicalInput = LocalCanonicalInput | PinCanonicalInput;

const KEYSTORE_HMAC_PREFIX = 'mtc-v1|keystore-record|';

function identityString(id: KeyIdentity): string {
	return [
		`v=${id.v}`,
		'mode=local',
		`keystoreGeneration=${id.keystoreGeneration}`,
		`epoch=${id.epoch}`,
		`installUuid=${byteHex(id.installUuid)}`
	].join('\n');
}

/**
 * Canonical bytes of the keystore record (excluding ivCounter, recordHmac, and
 * key refs). Nothing in the app uses it: it is kept because the older
 * canonical-form tests call it.
 */
export function canonicalizeKeystore(r: KeystoreCanonicalInput): Uint8Array {
	return keyIdentityBytes(keyIdentity(r));
}

/**
 * Prefixed canonical bytes that BOTH sign and verify run over. The NIST SP
 * 800-108-style domain-separation prefix is part of the MAC input, so a
 * keystore-record MAC can never validate against sidecar/broadcast canonical
 * bytes of the same shape.
 */
function recordHmacInput(r: LocalCanonicalInput): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(KEYSTORE_HMAC_PREFIX + identityString(r));
}

export function computeRecordHmac(
	r: LocalCanonicalInput,
	hmacKey: CryptoKey
): Promise<ArrayBuffer> {
	return hmacSign(hmacKey, recordHmacInput(r));
}

/**
 * Verify half of computeRecordHmac (constant-time via subtle.verify). Consumed
 * by ProfileStore.load for the fail-closed keystore-record integrity check.
 */
export function verifyRecordHmac(
	r: LocalCanonicalInput,
	hmacKey: CryptoKey,
	mac: ArrayBuffer
): Promise<boolean> {
	return hmacVerify(hmacKey, recordHmacInput(r), mac);
}

/** What binds every encrypted record to its keystore (the AAD's keystore fingerprint). */
export type KeyIdentity = Readonly<{
	v: 1;
	keystoreGeneration: number;
	epoch: number;
	installUuid: Uint8Array;
}>;

export function keyIdentity(row: KeystoreCanonicalInput): KeyIdentity {
	return {
		v: row.v,
		keystoreGeneration: row.keystoreGeneration,
		epoch: row.epoch,
		installUuid: row.installUuid
	};
}

/**
 * The canonical text every stored record's AAD and MAC were built over. The mode is the frozen literal `local` and not a
 * field of the identity, so a later change of lock mode never moves a stored record's AAD.
 */
export function keyIdentityBytes(id: KeyIdentity): Uint8Array {
	return new TextEncoder().encode(identityString(id));
}

/** The keys a tab may use with a row. In local mode the row's own HMAC key signs the row. */
export type KeystoreKeys = Readonly<{
	dataKey: CryptoKey;
	hmacKey: CryptoKey;
	bootstrapMacKey: CryptoKey;
}>;

/** All the record MAC needs of the keys: the one that signs the row. A caller that holds all three may pass them. */
export type MacKeys = Pick<KeystoreKeys, 'bootstrapMacKey'> & Partial<KeystoreKeys>;

const PIN_HMAC_PREFIX = 'mtc-v1|keystore-record-pin|';

/**
 * What a PIN row's MAC covers: the key identity's text, then the lock mode, the KDF tuple, the salt and the wrapped bag.
 * Fixed-length lowercase hex throughout, so no two rows share a text. Odd bytes are refused before any MAC is made.
 */
export function recordCanonical(row: PinCanonicalInput): Uint8Array {
	const { kdf, salt, bag } = row;
	if (
		!(salt instanceof Uint8Array) ||
		salt.length !== PIN_SALT_BYTES ||
		!(bag instanceof Uint8Array) ||
		bag.length !== PIN_BAG_BYTES
	) {
		throw new Error('E_KEYSTORE_SHAPE');
	}
	return new TextEncoder().encode(
		[
			identityString(row),
			'lock=pin',
			`kdf=argon2id-v${kdf.v}-m${kdf.m}-t${kdf.t}-p${kdf.p}-len${kdf.dkLen}`,
			`salt=${byteHex(salt)}`,
			`bag=${byteHex(bag)}`
		].join('\n')
	);
}

function pinMacInput(row: PinCanonicalInput): Uint8Array<ArrayBuffer> {
	const body = recordCanonical(row);
	const prefix = new TextEncoder().encode(PIN_HMAC_PREFIX);
	const out = new Uint8Array(prefix.length + body.length);
	out.set(prefix, 0);
	out.set(body, prefix.length);
	return out;
}

/**
 * The keystore record MAC under the key that signs the row. A local row: its canonical text under its own HMAC key. A
 * PIN row: recordCanonical under the PIN-derived HMAC key, with a prefix of its own so neither MAC can stand for the other.
 */
export async function signKeystore(
	row: KeystoreCanonicalInput,
	keys: MacKeys
): Promise<ArrayBuffer> {
	if (row.mode === 'pin') return hmacSign(keys.bootstrapMacKey, pinMacInput(row));
	return computeRecordHmac(row, keys.bootstrapMacKey);
}

/** False when the row has no recordHmac, has odd bytes where a PIN row needs fixed lengths, or the MAC does not verify. */
export async function verifyKeystore(
	row: KeystoreCanonicalInput & { recordHmac?: ArrayBuffer },
	keys: MacKeys
): Promise<boolean> {
	if (!row.recordHmac) return false;
	if (row.mode === 'pin') {
		let input: Uint8Array<ArrayBuffer>;
		try {
			input = pinMacInput(row);
		} catch {
			return false;
		}
		return hmacVerify(keys.bootstrapMacKey, input, row.recordHmac);
	}
	return verifyRecordHmac(row, keys.bootstrapMacKey, row.recordHmac);
}

function byteHex(b: Uint8Array): string {
	return Array.from(b)
		.map((x) => x.toString(16).padStart(2, '0'))
		.join('');
}
