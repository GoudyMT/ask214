import { keyIdentity, verifyKeystore, type KeyIdentity, type KeystoreRecordPin } from './record';

/**
 * The keys one tab holds in memory after a PIN unlock. Nothing here is stored: a reload drops it, and the next read finds
 * no session and refuses. The row it unlocked is named by `identity` and the lock counter noted before the derive, so a
 * key read can tell when the rows have moved on under it.
 */
export type KeySession = Readonly<{
	dataKey: CryptoKey;
	hmacKey: CryptoKey;
	bootstrapMacKey: CryptoKey;
	identity: KeyIdentity;
	counter: number;
}>;

export class WrongPinError extends Error {
	constructor() {
		super('E_WRONG_PIN');
		this.name = 'WrongPinError';
	}
}

export class KeystoreLockedError extends Error {
	constructor() {
		super('E_KEYSTORE_LOCKED');
		this.name = 'KeystoreLockedError';
	}
}

// Wrapped keys are 32 bytes plus AES-KW's 8; the bag holds the data key, then the HMAC key.
const WRAPPED_KEY_BYTES = 40;
const MIN_HMAC_KEY_BITS = 256;

let session: KeySession | null = null;
let onMismatch: (() => void) | null = null;
let ownKeyChanges = 0;

export function getSession(): KeySession | null {
	return session;
}

export function setSession(s: KeySession): void {
	assertSessionKeys(s);
	session = s;
}

export function dropSession(): void {
	session = null;
}

export function setOnSessionMismatch(handler: (() => void) | null): void {
	onMismatch = handler;
}

/**
 * This tab's own key change (Change PIN, Remove PIN): while `fn` runs, a row that no longer matches the session does not
 * relock the tab, since the caller is the one changing it and sets the new session, or drops it, itself. It is a flag of
 * this tab: any key read in the tab during `fn` is exempt, so keep `fn` to the change.
 */
export async function withOwnKeyChange<T>(fn: () => Promise<T>): Promise<T> {
	ownKeyChanges++;
	try {
		return await fn();
	} finally {
		ownKeyChanges--;
	}
}

export function inOwnKeyChange(): boolean {
	return ownKeyChanges > 0;
}

/** A key read found the rows no longer fit the session: forget the keys, tell the app to relock, and refuse. */
export function failMismatch(): never {
	dropSession();
	onMismatch?.();
	throw new KeystoreLockedError();
}

const sameUsages = (key: CryptoKey, expected: readonly string[]): boolean =>
	key.usages.length === expected.length &&
	expected.every((u) => key.usages.includes(u as KeyUsage));

function isDataKey(key: CryptoKey): boolean {
	return (
		key instanceof CryptoKey &&
		!key.extractable &&
		key.algorithm.name === 'AES-GCM' &&
		(key.algorithm as AesKeyAlgorithm).length === 256 &&
		sameUsages(key, ['encrypt', 'decrypt'])
	);
}

function isMacKey(key: CryptoKey): boolean {
	return (
		key instanceof CryptoKey &&
		!key.extractable &&
		key.algorithm.name === 'HMAC' &&
		(key.algorithm as HmacKeyAlgorithm).hash.name === 'SHA-256' &&
		(key.algorithm as HmacKeyAlgorithm).length >= MIN_HMAC_KEY_BITS &&
		sameUsages(key, ['sign', 'verify'])
	);
}

/** Every key a session holds is non-extractable, of the algorithm its job needs, and has exactly the usages that job needs. */
export function assertSessionKeys(
	s: Pick<KeySession, 'dataKey' | 'hmacKey' | 'bootstrapMacKey'>
): void {
	if (!isDataKey(s.dataKey) || !isMacKey(s.hmacKey) || !isMacKey(s.bootstrapMacKey)) {
		throw new Error('E_KEY_SHAPE');
	}
}

/**
 * From a PIN row and the two keys the PIN step derived: the record MAC is checked under the MAC key (a MAC that fails at
 * unlock means the PIN is wrong), then the bag is unwrapped under the wrapping key into keys that cannot be extracted.
 * Does not set the session.
 */
export async function openPinSession(
	row: KeystoreRecordPin,
	pinKeys: { macKey: CryptoKey; kek: CryptoKey },
	counter: number
): Promise<KeySession> {
	if (!(await verifyKeystore(row, { bootstrapMacKey: pinKeys.macKey }))) throw new WrongPinError();
	let dataKey: CryptoKey;
	let hmacKey: CryptoKey;
	try {
		dataKey = await crypto.subtle.unwrapKey(
			'raw',
			row.bag.slice(0, WRAPPED_KEY_BYTES),
			pinKeys.kek,
			'AES-KW',
			{ name: 'AES-GCM' },
			false,
			['encrypt', 'decrypt']
		);
		hmacKey = await crypto.subtle.unwrapKey(
			'raw',
			row.bag.slice(WRAPPED_KEY_BYTES),
			pinKeys.kek,
			'AES-KW',
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign', 'verify']
		);
	} catch {
		// The MAC held, so the bag is the one that was made; a bag the wrapping key cannot open is a damaged row, not a typo.
		throw new Error('E_KEYSTORE_SHAPE');
	}
	const keys = { dataKey, hmacKey, bootstrapMacKey: pinKeys.macKey };
	assertSessionKeys(keys);
	return { ...keys, identity: keyIdentity(row), counter };
}
