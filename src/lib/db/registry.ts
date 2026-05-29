/**
 * Registry of IDB stores that MUST be encrypted-at-rest via ProfileStore.encrypt.
 *
 * Anti-pattern guarded: writes against unregistered "encrypted" stores. The
 * `mtc/encrypted-store-registry` ESLint rule enforces this at lint time.
 *
 * Rotation/migration manifests enumerate this registry; adding a new encrypted
 * store therefore requires registering it here.
 *
 * Source: Phase 2 spec section 4 (invariant 7: encrypted-store enumeration).
 */
export const ENCRYPTED_STORES = Object.freeze(['profile'] as const);

export type EncryptedStoreName = (typeof ENCRYPTED_STORES)[number];

export function isEncryptedStore(name: string): name is EncryptedStoreName {
	return (ENCRYPTED_STORES as readonly string[]).includes(name);
}
