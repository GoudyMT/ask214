/**
 * Deps for eraseEverything, injected so the whole destructive path is testable without a browser -
 * including the branches where it fails partway.
 */
export type EraseDeps = {
	/** Zeroize decrypted state in memory + scrub registered inputs. */
	relock: () => void;
	/** Clear every registered store by registry name. Null before app-init resolves. */
	wipeAll: (() => Promise<void>) | null;
	clearStorage: () => void;
	clearCaches: () => Promise<void>;
	reload: () => void;
};

/**
 * Erase everything on this device, in the one order that is safe.
 *
 * Zeroization runs FIRST. The reload is what actually removes cleartext from the page, but it is the
 * last step and every step before it can throw - a failure there would otherwise leave the decrypted
 * profile and any typed input resident on a page whose database is already gone.
 *
 * Refuses outright when `wipeAll` is unavailable rather than erasing the layers it can reach: a
 * partial erase strands encrypted rows under a keystore epoch nothing can verify again, and the only
 * recovery is the erase itself.
 */
export async function eraseEverything(deps: EraseDeps): Promise<void> {
	if (!deps.wipeAll) return;
	deps.relock();
	await deps.wipeAll();
	deps.clearStorage();
	await deps.clearCaches();
	deps.reload();
}
