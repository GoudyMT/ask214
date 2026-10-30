import { APP_SHELL, WORKER_SCRIPT_FOLDER } from '#lib/ask/asset-cache.js';

/**
 * Clear Cache Storage for an erase, keeping only the app's own code.
 *
 * Deleting the app code cache too left the app unable to open offline after an erase: nothing reinstalls it until
 * the next release. Those files are the same for every user, so keeping them keeps nothing of the user's. Every
 * other cache goes - saved documents, the on-device model, the answer library - and inside the app code caches, so
 * does what use added: each page opened (a file name with no extension) and the embed worker's script, which is
 * kept only on a device that set up on-device answers. Every app cache is kept, not only this page's release, so an
 * update waiting to activate keeps its files. A failed delete throws, so the erase does not report itself done.
 *
 * @param storage Cache Storage, or a test's stand-in.
 */
export async function eraseCaches(
	storage: Pick<CacheStorage, 'keys' | 'open' | 'delete'>
): Promise<void> {
	for (const name of await storage.keys()) {
		if (!name.startsWith('app-')) {
			await storage.delete(name);
			continue;
		}
		const cache = await storage.open(name);
		for (const request of await cache.keys()) {
			const { pathname } = new URL(request.url);
			const fileName = pathname.slice(pathname.lastIndexOf('/') + 1);
			const kept =
				pathname === APP_SHELL ||
				(fileName.includes('.') && !pathname.startsWith(WORKER_SCRIPT_FOLDER));
			if (!kept) await cache.delete(request);
		}
	}
}
