export type CacheStrategy = 'precache' | 'lazy';

/**
 * Decide how the service worker caches a same-origin static asset. The heavy on-device search model +
 * ORT WASM (~45MB total: model + asyncify WASM) AND the ~3.5MB corpus are cached LAZILY - fetched + cached
 * on first use (a device query or a "Read more" click), never eagerly precached at install. That keeps SW
 * install light + robust (a flaky connection can't fail the whole install on a multi-megabyte asset), keeps
 * the corpus off every passive page load (so it never blocks LCP/TTI), and spares online-only users the
 * corpus download. Everything else (the app shell + icons) is precached so the shell works offline at once.
 *
 * The lazy prefixes mirror the worker's self-host config: `localModelPath = '/models/'` and
 * `wasmPaths = '/wasm/'` (see embed-worker.ts); `/corpus/` is the versioned corpus artifact.
 *
 * `/docs/` (the served source documents, ~40MB across 21 files) and `/pdf-worker/` (~1.7MB) join them
 * for the same reason, and one sharper one: install writes its precache entries as a single batch, so a
 * heavy namespace admitted here does not merely cost bytes for a user who never opens a document - one
 * failed fetch among them fails the entire service-worker install. Both are fetched only when a reader opens
 * or a document is saved (and the library again after an update, on a device that saved one), which is when
 * the user has asked for them. A new heavy namespace belongs in this list
 * BEFORE it ships, not after someone notices the install got slower.
 */
export function classifyAsset(pathname: string): CacheStrategy {
	if (
		pathname.startsWith('/models/') ||
		pathname.startsWith('/wasm/') ||
		pathname.startsWith('/corpus/') ||
		pathname.startsWith('/docs/') ||
		pathname.startsWith('/pdf-worker/')
	)
		return 'lazy';
	return 'precache';
}

/**
 * The lazy model + ORT WASM (~45MB) live in this OWN cache, whose name is INDEPENDENT of the app version -
 * so an app deploy (which deletes stale `app-${version}` caches) does NOT evict the heavy download (the
 * "downloaded once, works offline" promise holds). The `-vN` suffix is the ONLY cache-bust seam for the
 * vendored model + wasm, whose URLs are stable and served cache-first forever: when those bytes are
 * re-vendored (e.g. an onnxruntime-web security patch), BUMP this suffix - activate then carries the user's
 * saved documents, page reader and answer library into the new cache (`carryOverSavedDocuments`), evicts the
 * old one, and the new model bytes are re-fetched on next use. The corpus is versioned the
 * OPPOSITE way - by URL, renaming the artifact - and that does NOT evict anything: the old URL merely stops
 * being requested while its entry stays cached at full size. Superseded corpus entries are therefore pruned
 * one at a time on activate (see `isSupersededVersionedEntry`). Also cleared by an explicit wipe.
 */
export const ASK_ASSET_CACHE = 'ask-assets-v1';

/**
 * Where the corpus artifact - the answer library - is served, without its extension. The filename changes
 * whenever the content does (the cache keeps a URL forever), so every page that loads the corpus, and a save
 * that stores it with a document, reads this one value. It lives here, not in the loader, so a save can name
 * it without taking the corpus decoder along.
 */
export const CORPUS_BASE = '/corpus/corpus-v1.0.2';

/**
 * The answer library's two files together - its text and its vectors - which a first save states it also stores
 * while they are missing. A test holds it to the files on disk, so a new corpus fails until it is stated again.
 */
export const CORPUS_BYTES = 7_347_321;

/**
 * On service-worker activate, decide whether to keep a cache. Keep the current app-shell cache and the
 * lazy asset cache; delete everything else (stale app-shell caches from prior versions).
 *
 * Args:
 *   key: a cache name from caches.keys()
 *   appCacheName: the current app-shell cache name (`app-${version}`)
 *
 * Returns:
 *   true to keep the cache, false to delete it.
 */
export function shouldKeepCache(key: string, appCacheName: string): boolean {
	return key === appCacheName || key === ASK_ASSET_CACHE;
}

/** An asset cache from before a cache-bust gave ASK_ASSET_CACHE its current name. */
function isEarlierAssetCache(key: string): boolean {
	return key !== ASK_ASSET_CACHE && /^ask-assets-v\d+$/.test(key);
}

/**
 * What the user keeps in the asset cache: saved documents, and the page reader and answer library that draw
 * and read them. The model and the WASM are not here - a new cache name exists to replace them.
 */
const CARRIED_OVER = ['/docs/', '/pdf-worker/', '/corpus/'];

/**
 * Carry what the user keeps from every earlier asset cache into the current one, before activate deletes the
 * earlier ones.
 *
 * Renaming the asset cache is how new model or WASM bytes reach a returning device: activate deletes the old
 * cache whole. Saved documents live in that same cache, and a saved document is kept until the user removes
 * it, so a rename must not take them. A copy the current cache already holds is left as it is. A cache is
 * reported carried only when every copy succeeded, so one that failed - a full disk - survives this activate
 * and is tried again at the next, rather than being deleted with the documents inside it.
 *
 * @param cachesApi The Cache API; injected by tests.
 * @returns The names of the earlier caches whose kept entries are now all in the current cache.
 */
export async function carryOverSavedDocuments(cachesApi: CacheStorage): Promise<Set<string>> {
	const carried = new Set<string>();
	const earlier = (await cachesApi.keys()).filter(isEarlierAssetCache);
	if (earlier.length === 0) return carried;
	const current = await cachesApi.open(ASK_ASSET_CACHE);
	for (const name of earlier) {
		try {
			const cache = await cachesApi.open(name);
			for (const request of await cache.keys()) {
				const { pathname } = new URL(request.url);
				if (!CARRIED_OVER.some((prefix) => pathname.startsWith(prefix))) continue;
				if ((await current.match(request, { ignoreVary: true })) !== undefined) continue;
				const response = await cache.match(request, { ignoreVary: true });
				if (response !== undefined) await current.put(request, response);
			}
			carried.add(name);
		} catch {
			// Not carried: kept for the next activate - see above.
		}
	}
	return carried;
}

/**
 * On activate, whether to keep a cache: the current ones, and an earlier asset cache until what the user kept in
 * it has been carried over.
 *
 * @param key A cache name from caches.keys().
 * @param appCacheName The current app-shell cache name.
 * @param carried The earlier asset caches carryOverSavedDocuments finished.
 * @returns true to keep the cache, false to delete it.
 */
export function keptOnActivate(key: string, appCacheName: string, carried: Set<string>): boolean {
	return shouldKeepCache(key, appCacheName) || (isEarlierAssetCache(key) && !carried.has(key));
}

/** The namespaces inside ASK_ASSET_CACHE versioned by URL, where each new build can orphan the last one's files. */
const VERSIONED_NAMESPACES = ['/corpus/', '/docs/', '/pdf-worker/'];

/**
 * A served document's source id: its filename up to the first dot (`tap_vet_centers.1dcfd966.pdf`). Read by
 * position after `/docs/`, so callers check the namespace first.
 */
export function documentSourceId(pathname: string): string {
	return pathname.slice('/docs/'.length).split('.')[0] ?? '';
}

/**
 * Decide whether one cached ENTRY inside ASK_ASSET_CACHE is something this build no longer ships.
 *
 * `shouldKeepCache` works at whole-cache granularity and keeps ASK_ASSET_CACHE unconditionally, so nothing
 * else ever retires anything inside it. That is right for the model + ORT WASM, which are served from stable
 * URLs and so are overwritten in place, but wrong for the three namespaces versioned BY URL: a corpus content
 * change renames `corpus-vX.*` to `corpus-vY.*`, a pdf.js upgrade moves its library and worker to a new
 * `/pdf-worker/<release>/` folder, and a recaptured document gets a new hash in its name. Each time the cache
 * gains the new files while keeping the old ones forever. Left alone, every rebuild adds dead weight next to
 * the ~45MB model, and a browser that evicts the whole origin under storage pressure (Safari/iOS) takes the
 * model down with it.
 *
 * Documents are the exception inside that rule. A saved document stays until the user removes it, so an older
 * copy of a document this build still ships is NOT marked: it is the record that tells the Documents area the
 * document was updated, and saving it again or removing it there deletes it. Documents are therefore compared
 * by SOURCE ID, and only one whose source this build no longer ships is marked.
 *
 * Two conditions must BOTH hold before an entry is marked, which is what bounds over-eviction:
 *   - the entry is inside a versioned namespace (each one `classifyAsset` routes into this cache), so a
 *     `/models/` or `/wasm/` entry can never match no matter what the asset list contains;
 *   - this build ships something in THAT namespace, checked per namespace, so an unexpected asset list (a
 *     namespace served from somewhere other than the static directory, or an empty list) prunes nothing there
 *     instead of wiping the live copy - or every document the user saved. A stale entry costs bytes; a wrongly
 *     deleted one costs an offline user their answers.
 *
 * Args:
 *   pathname: the pathname of a cached entry's request URL
 *   currentAssets: the pathnames this build ships (the service worker's build + files list), which carries
 *     each namespace's current identity - so no filename or release is hardcoded here and a bump needs no edit
 *
 * Returns:
 *   true when the entry is superseded and can be deleted.
 */
export function isSupersededVersionedEntry(
	pathname: string,
	currentAssets: readonly string[]
): boolean {
	const namespace = VERSIONED_NAMESPACES.find((prefix) => pathname.startsWith(prefix));
	if (namespace === undefined) return false;
	const shipped = currentAssets.filter((asset) => asset.startsWith(namespace));
	if (shipped.length === 0) return false;
	if (namespace === '/docs/') {
		const sourceId = documentSourceId(pathname);
		return !shipped.some((asset) => documentSourceId(asset) === sourceId);
	}
	return !shipped.includes(pathname);
}

/**
 * Decide which PDF library files the service worker restores on activate, so a saved document still draws
 * its page offline after an update.
 *
 * Saving a document stores the library with it, but a pdf.js upgrade moves the library to a new
 * `/pdf-worker/<release>/` folder: activate prunes the old pair, and nothing else would store the new one
 * until a reader opens online. Until then every saved document opens offline only as text.
 *
 * Only a device that holds a saved document gets the library back - one that saved nothing never asked for it
 * to be kept. Only library files are returned, never another shipped file the cache lacks: every document,
 * the corpus and the app shell are in the shipped list too.
 *
 * Args:
 *   cachedPaths: the same-origin pathnames held in ASK_ASSET_CACHE
 *   shipped: the pathnames this build ships (the service worker's build + files list), which carries the
 *     current release's folder - so no release is hardcoded here and a bump needs no edit
 *
 * Returns:
 *   the shipped library pathnames to fetch and store; empty when nothing is saved or the library is held.
 */
export function libraryToRestore(
	cachedPaths: readonly string[],
	shipped: readonly string[]
): string[] {
	if (!cachedPaths.some((path) => path.startsWith('/docs/'))) return [];
	return shipped.filter((path) => path.startsWith('/pdf-worker/') && !cachedPaths.includes(path));
}

/**
 * Decide whether the service worker keeps a response it passes through to the page.
 *
 * Everything it passes is kept, except a source document: viewing a document keeps nothing, and only the
 * user's explicit save puts one on the device (the page writes that copy itself, so a full disk reaches it).
 * A document the worker kept on every view would fill the device with files the user never chose to keep,
 * up to 40 MB, and none of them would show as saved or be removable one by one.
 *
 * Args:
 *   pathname: a same-origin request pathname
 *
 * Returns:
 *   true when the worker may cache the response.
 */
export function keptOnFetch(pathname: string): boolean {
	return !pathname.startsWith('/docs/');
}

/**
 * Keep a copy of a response the service worker is handing back, without the write being lost or surfacing
 * as a failure. The write runs under the fetch event's `waitUntil`, so the browser keeps the worker alive
 * until it lands rather than stopping an idle worker mid-write; a write that fails - a full disk above all -
 * ends quietly, because the response was already served and the next request fetches and tries again.
 *
 * @param event The fetch event whose lifetime the write extends.
 * @param cache The cache to write into.
 * @param request The request the copy is stored under.
 * @param response The response being served; a copy is stored, so the response itself stays unread.
 */
export function storeOnFetch(
	event: { waitUntil(promise: Promise<unknown>): void },
	cache: Cache,
	request: Request,
	response: Response
): void {
	event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
}

/**
 * The service worker must never cache the `/api/` namespace: the retrieve endpoint is dynamic and
 * request-specific, so a cached response could serve stale or another context's data. A matching request
 * passes straight to the network (the SW does not handle it). The cross-origin browser-direct synthesis
 * call never reaches the SW's same-origin fetch handler at all.
 *
 * @param pathname A same-origin request pathname.
 * @returns true when the request is in the /api/ namespace and must bypass the SW cache.
 */
export function isApiRequest(pathname: string): boolean {
	return pathname.startsWith('/api/');
}
