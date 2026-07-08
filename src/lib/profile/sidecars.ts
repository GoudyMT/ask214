import { hmacSign, hmacVerify } from '../crypto/hmac';

/**
 * Signed sidecar pattern. Plaintext metadata in IDB is FORGEABLE (the encryption
 * boundary protects ciphertext, not adjacent stores). Sidecars carry monotonic
 * counters + epoch + timestamps; integrity is enforced by HMAC under the single
 * keystore hmacKey, with a NIST SP 800-108-style domain-separation prefix
 * so a sidecar MAC can never validate as a keystore-record (or broadcast) MAC.
 */
const SIDECAR_HMAC_PREFIX = 'mtc-v1|sidecar|';

export type SignedSidecar<T> = {
	v: 1;
	payload: T;
	mac: ArrayBuffer; // HMAC-SHA-256 under the keystore hmacKey, mtc-v1|sidecar|-prefixed
};

export type ProfileHwmPayload = {
	generation: number;
	keystoreGeneration: number;
	epoch: number;
	ts: number;
};

export class SidecarTamperError extends Error {
	constructor() {
		super('E_SIDECAR_TAMPER');
		this.name = 'SidecarTamperError';
	}
}

/**
 * Deterministic JSON with recursively sorted object keys (stable regardless of
 * key insertion order) - the basis for a reproducible MAC.
 */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
		.join(',')}}`;
}

function canonical(name: string, payload: unknown): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(SIDECAR_HMAC_PREFIX + canonicalJson({ name, payload }));
}

export async function signSidecar<T>(
	name: string,
	payload: T,
	hmacKey: CryptoKey
): Promise<SignedSidecar<T>> {
	const mac = await hmacSign(hmacKey, canonical(name, payload));
	return { v: 1, payload, mac };
}

export async function verifySidecar<T>(
	expectedName: string,
	signed: SignedSidecar<T>,
	hmacKey: CryptoKey
): Promise<T> {
	const ok = await hmacVerify(hmacKey, canonical(expectedName, signed.payload), signed.mac);
	if (!ok) throw new SidecarTamperError();
	return signed.payload;
}
