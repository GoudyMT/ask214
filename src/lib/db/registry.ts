/**
 * Registry of IDB stores that hold AES-GCM ciphertext (written only via the sanctioned record-crypto boundary).
 *
 * Anti-pattern guarded: writes against unregistered "encrypted" stores. The
 * `mtc/encrypted-store-registry` ESLint rule enforces this at lint time, from its
 * own hardcoded copy of this list (it is a plain-JS plugin and cannot import this
 * module). Adding a store HERE alone leaves it unguarded, so that rule's test file
 * asserts the two lists match - update both, or that test fails.
 *
 * Rotation/migration manifests enumerate this registry; adding a new encrypted
 * store therefore requires registering it here.
 */
export const ENCRYPTED_STORES = Object.freeze([
	'profile',
	'timeline-state',
	'calendar-sync',
	'byok'
] as const);

export type EncryptedStoreName = (typeof ENCRYPTED_STORES)[number];

export function isEncryptedStore(name: string): name is EncryptedStoreName {
	return (ENCRYPTED_STORES as readonly string[]).includes(name);
}
