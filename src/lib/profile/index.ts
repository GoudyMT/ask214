/**
 * Public Profile module API. Features consume the profile + persona through here.
 *
 * The decrypted profile state (`_profile`) is NOT exported - it is private to the
 * ProfileStore factory closure (structural encapsulation, stronger than a lint
 * rule). Read it only through the reactive `persona` getter on a store instance.
 */
export {
	createProfileStore,
	KeystoreNotInitializedError,
	KeystoreHmacMismatchError,
	OccConflictError
} from './store.svelte';
export type { ProfilePatch, BroadcastEvent, ProfileStoreOptions } from './store.svelte';
export { derivePersona, type PersonaFilters } from './persona';
export type { ProfileV1, SetupIntent } from './types';
