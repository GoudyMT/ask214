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
 * one at a time on activate (see `isSupersededVersionedEntry`). A device that kept a library is given the new one
 * at install (see `answerLibraryToRestore`), when the old pair is still held and a full disk can refuse it, and
 * again after activation, once the prune has freed the room. Also cleared by an explicit wipe.
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
 * The files a set-up of on-device answers stores besides the answer library: the search model and the runtime that
 * runs it. A device that holds every one of them has finished setting up (`deviceFinishedSetUp`). The paths are
 * written out rather than read from the vendored manifest, so the service worker does not carry the manifest's
 * hashes; tests hold them to the manifest and to the files the app ships. The page keeps its own written-out copy
 * of this list, which a test holds equal to this one plus the answer library.
 */
export const SET_UP_FILES: readonly string[] = [
	'/models/Xenova/all-MiniLM-L6-v2/config.json',
	'/models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json',
	'/models/Xenova/all-MiniLM-L6-v2/tokenizer.json',
	'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
	'/wasm/ort-wasm-simd-threaded.asyncify.mjs',
	'/wasm/ort-wasm-simd-threaded.asyncify.wasm'
];

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
 * Delete every entry of the asset cache that `isSupersededVersionedEntry` marks - the one prune the service worker
 * runs on activate, kept here so a test runs the worker's own rule on a full device instead of a copy of it.
 *
 * It deletes on the version rule alone. A condition that held an earlier answer library back - until the current
 * one was stored, say - would keep the old pair on a nearly full device, which is where the new pair then cannot
 * be stored: the room it needs is the room the old pair holds.
 *
 * It does not catch: a cache call that rejects reaches the caller. The worker's wrapper owns that guard, because a
 * prune is housekeeping and an error escaping activation would strand clients on the previous worker.
 *
 * @param cache ASK_ASSET_CACHE, to read the held entries from and delete from.
 * @param origin This worker's origin; only entries under it are read, so the pathnames compared with the shipped
 *   list are this app's own.
 * @param shipped The pathnames this build ships (the service worker's build + files list).
 */
export async function pruneSupersededEntries(
	cache: Pick<Cache, 'keys' | 'delete'>,
	origin: string,
	shipped: readonly string[]
): Promise<void> {
	const held: { request: Request; pathname: string }[] = [];
	for (const request of await cache.keys()) {
		const url = new URL(request.url);
		// Entries here are written by the same-origin fetch handler, by the page saving a document (the document and
		// the PDF library) and by the library restore, all under this origin; the origin check keeps the pathname
		// comparison against the shipped list meaningful even so.
		if (url.origin === origin) held.push({ request, pathname: url.pathname });
	}
	for (const { request, pathname } of held) {
		if (isSupersededVersionedEntry(pathname, shipped)) await cache.delete(request);
	}
}

/**
 * Whether a device finished setting up on-device answers: it holds every model and runtime file (`SET_UP_FILES`).
 *
 * A setup stopped part-way - the model's small files stored, the 23 MB model not yet - holds some of them and has
 * asked for nothing to be kept, so it is not set up. The answer library is not in the test: it is what a finished
 * setup is owed, not part of the finishing.
 *
 * @param cachedPaths The same-origin pathnames held in ASK_ASSET_CACHE.
 * @returns true only when every model and runtime file is held.
 */
export function deviceFinishedSetUp(cachedPaths: readonly string[]): boolean {
	return SET_UP_FILES.every((path) => cachedPaths.includes(path));
}

/**
 * Whether a device holds a saved document this build still ships. Activation deletes a saved document whose source
 * the build no longer ships (`isSupersededVersionedEntry`), so one cannot be why the device is owed a library: the
 * copy is gone by the time the library would be used.
 */
function holdsShippedDocument(cachedPaths: readonly string[], shipped: readonly string[]): boolean {
	return cachedPaths.some(
		(path) => path.startsWith('/docs/') && !isSupersededVersionedEntry(path, shipped)
	);
}

/**
 * Decide which PDF library files the service worker restores at install and again after activation, so a saved
 * document still draws its page offline after an update.
 *
 * Saving a document stores the library with it, but a pdf.js upgrade moves the library to a new
 * `/pdf-worker/<release>/` folder: activate prunes the old pair, and nothing else would store the new one
 * until a reader opens online. Until then every saved document opens offline only as text.
 *
 * Only a device that holds a saved document gets the library back - one that saved nothing never asked for it
 * to be kept. A saved document counts only while this build still ships its source: activation deletes one it
 * does not, so a device holding only that copy would be given a library for nothing. Only library files are
 * returned, never another shipped file the cache lacks: every document, the corpus and the app shell are in the
 * shipped list too.
 *
 * Args:
 *   cachedPaths: the same-origin pathnames held in ASK_ASSET_CACHE
 *   shipped: the pathnames this build ships (the service worker's build + files list), which carries the
 *     current release's folder and the sources it still ships - so no release is hardcoded here and a bump needs
 *     no edit
 *
 * Returns:
 *   the shipped library pathnames to fetch and store; empty when no saved document is still shipped or the library
 *   is held.
 */
export function libraryToRestore(
	cachedPaths: readonly string[],
	shipped: readonly string[]
): string[] {
	if (!holdsShippedDocument(cachedPaths, shipped)) return [];
	return shipped.filter((path) => path.startsWith('/pdf-worker/') && !cachedPaths.includes(path));
}

/**
 * Decide which answer-library files the service worker fetches at install, so a device that kept the library
 * still answers on the device - offline too - after a release that renames it.
 *
 * The library is versioned by URL: a new release ships a new pair, which an earlier release's pair cannot stand in
 * for, and activate prunes the earlier one. Without this, a device that set up on-device answers (or saved a
 * document) would be asked to set up again although it still holds the model, and could not answer offline until
 * it did. Install runs while online, so the pair is fetched then, and again after activation for any file that
 * could not be stored.
 *
 * The device is owed the pair when it finished setting up (`deviceFinishedSetUp`: the whole model and runtime held)
 * or holds a saved document this build still ships, and lacks a file of the current pair. Setup always downloads the
 * library, and a document's first save always stores it, so either one means this device kept a library; no earlier
 * pair needs to be held, which is what lets activate delete it at once. Two cases are not owed it, because each
 * would download several megabytes the device never asked to keep: a setup abandoned part-way (the model's small
 * files stored, the 23 MB model not yet), which on a nearly full device would repeat with every release since there
 * is no earlier pair for the prune to free; and a saved document whose source this build no longer ships, which
 * activation deletes. The worker also keeps the library when a page merely reads it ("Read more", a document's
 * text), but that device never set up or saved anything, so a release downloads nothing for it.
 *
 * Args:
 *   cachedPaths: the same-origin pathnames held in ASK_ASSET_CACHE
 *   shipped: the pathnames this build ships, which carries the current library's name and the sources it ships
 *
 * Returns:
 *   the shipped answer-library pathnames to fetch and store; empty when the device kept no library or holds the
 *   current one.
 */
export function answerLibraryToRestore(
	cachedPaths: readonly string[],
	shipped: readonly string[]
): string[] {
	if (!deviceFinishedSetUp(cachedPaths) && !holdsShippedDocument(cachedPaths, shipped)) return [];
	return shipped.filter((path) => path.startsWith('/corpus/') && !cachedPaths.includes(path));
}

/**
 * How long the install-time restore waits on one library before giving it up.
 *
 * A bound, so a stalled download cannot hold the install - and with it the update - open. A miss is not free: the
 * files stored so far stay, but until the retry after activation, the next install or an online load stores the
 * rest, a set-up device cannot answer offline. The answer library is about 3.7 MB on the wire (its embeddings do not compress; measured from production with
 * compression on), so 60 seconds holds down to about 0.5 Mbps; this is a bound, not a measured limit.
 */
export const LIBRARY_RESTORE_DEADLINE_MS = 60_000;

/**
 * How long keeping the embed worker's script waits on its download before giving it up.
 *
 * A bound, so a stalled download cannot hold the install - and with it the update - open. The script is about
 * 517 KB, or about 147 KB compressed on the wire, which takes about 5 seconds on a slow 0.25 Mbps link; 20 seconds
 * leaves room beyond that and still ends a stall. It is a bound, not a measured limit. A miss costs the device
 * its offline answers after an update that changed the script, until the retry after activation or the first
 * online question stores it.
 */
export const WORKER_SCRIPT_DEADLINE_MS = 20_000;

/**
 * Fetch and store the library files this device is owed, each library in its own try and within its own deadline.
 *
 * The PDF library and the answer library are separate tries: one that fails or stalls costs the device only that
 * library, and the other is still fetched. Each has an AbortController that a timer fires after `deadlineMs`; its
 * signal goes to every fetch of that library, so a download that stalls - headers or body - is cut off instead of
 * holding the install. Only a 200 response is stored. Nothing here throws, so it cannot fail the install.
 *
 * Args:
 *   cache: ASK_ASSET_CACHE, to read the held entries from and store into
 *   fetchLibrary: the network fetch, given the path and the signal; injected by tests
 *   origin: this worker's origin; only entries under it are read, so the pathnames compared with the shipped list
 *     are this app's own
 *   shipped: the pathnames this build ships
 *   deadlineMs: how long each library may take
 */
export async function restoreLibraries(
	cache: Pick<Cache, 'keys' | 'put'>,
	fetchLibrary: (path: string, init: { signal: AbortSignal }) => Promise<Response>,
	origin: string,
	shipped: readonly string[],
	deadlineMs: number
): Promise<void> {
	let owed: string[][];
	try {
		const cachedPaths: string[] = [];
		for (const request of await cache.keys()) {
			const url = new URL(request.url);
			if (url.origin === origin) cachedPaths.push(url.pathname);
		}
		owed = [libraryToRestore(cachedPaths, shipped), answerLibraryToRestore(cachedPaths, shipped)];
	} catch {
		return;
	}
	for (const paths of owed) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), deadlineMs);
		try {
			for (const path of paths) {
				const response = await fetchLibrary(path, { signal: controller.signal });
				if (response.status === 200) await cache.put(path, response);
			}
		} catch {
			// This library is given up on - a failed or stalled download, or a full disk - with the files stored so
			// far kept. The other one is still tried, and this one is tried again after activation, fetching only
			// the files still missing.
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * Where the built embed worker's script is served from. `workers/assets/` beside it is where SvelteKit writes a
 * worker's non-script files.
 */
const WORKER_SCRIPT_FOLDER = '/_app/immutable/workers/';

/**
 * The worker scripts a built chunk starts, as absolute pathnames.
 *
 * SvelteKit's build list leaves a worker's script out, so the service worker cannot precache it from that list;
 * the one place this release names it is the page code that starts the worker, as a string literal ending in
 * `workers/<name>.js` that the page resolves against its own address (`new URL(literal, import.meta.url)`).
 * This resolves it the same way, against the chunk's pathname. Only a script directly in the worker folder
 * counts: `workers/assets/` is where SvelteKit writes a worker's non-script files, never a script to keep. The
 * name is taken only in the characters Vite uses for a worker file, so an encoded separator in it is refused.
 *
 * @param chunkPath The pathname the chunk is served from.
 * @param text The chunk's text.
 * @returns The worker script pathnames the chunk names, each once, in the order they appear.
 */
export function workerScriptsNamed(chunkPath: string, text: string): string[] {
	const named: string[] = [];
	for (const match of text.matchAll(/(["'`])([^"'`\s]*workers\/[\w-]+\.js)\1/g)) {
		const path = new URL(match[2] ?? '', `https://chunk.invalid${chunkPath}`).pathname;
		const inFolder =
			path.startsWith(WORKER_SCRIPT_FOLDER) &&
			!path.slice(WORKER_SCRIPT_FOLDER.length).includes('/');
		if (inFolder && !named.includes(path)) named.push(path);
	}
	return named;
}

/**
 * Keep the embed worker's script for a device that set up on-device answers, so its first question after an
 * update still starts the worker offline.
 *
 * The page fetches the script only when it first asks a question, and an update deletes the previous release's
 * cache, so a device that then goes offline has no script for the new release. Install runs while online and has
 * just stored this release's own page code: the script's name is read from it (`workerScriptsNamed`) and the
 * script stored beside it, where the fetch handler already looks. It lives as long as the release that names it.
 * A device that did not finish setting up (`deviceFinishedSetUp`: the whole model and runtime held) asked for no
 * offline answers yet - one stopped part-way has stored a few small model files and no more - and downloads nothing
 * here.
 *
 * Each script is its own try under one deadline, and nothing throws, so it cannot fail the install or hold it open.
 * Only a 200 response is stored. A script already held is not fetched again, so the same call after activation
 * stores what install could not and costs nothing once it is held.
 *
 * Args:
 *   assetCache: ASK_ASSET_CACHE, read to see whether the device set up
 *   releaseCache: this release's own cache, to read its code from and store the script into
 *   fetchScript: the network fetch, given the path and the signal; injected by tests
 *   origin: this worker's origin; only entries under it are read
 *   deadlineMs: how long the downloads may take
 */
export async function keepWorkerScripts(
	assetCache: Pick<Cache, 'keys'>,
	releaseCache: Pick<Cache, 'keys' | 'match' | 'put'>,
	fetchScript: (path: string, init: { signal: AbortSignal }) => Promise<Response>,
	origin: string,
	deadlineMs: number
): Promise<void> {
	let missing: string[];
	try {
		const sameOrigin = (requests: readonly Request[]) =>
			requests.map((request) => new URL(request.url)).filter((url) => url.origin === origin);
		const setUp = deviceFinishedSetUp(
			sameOrigin(await assetCache.keys()).map((url) => url.pathname)
		);
		if (!setUp) return;
		const held = await releaseCache.keys();
		const heldPaths = sameOrigin(held).map((url) => url.pathname);
		const named: string[] = [];
		for (const request of held) {
			const { origin: requestOrigin, pathname } = new URL(request.url);
			if (requestOrigin !== origin || !pathname.endsWith('.js')) continue;
			const text = await (await releaseCache.match(request))?.text();
			if (text === undefined) continue;
			for (const script of workerScriptsNamed(pathname, text))
				if (!named.includes(script)) named.push(script);
		}
		missing = named.filter((script) => !heldPaths.includes(script));
	} catch {
		return;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), deadlineMs);
	try {
		for (const path of missing) {
			try {
				const response = await fetchScript(path, { signal: controller.signal });
				if (response.status === 200) await releaseCache.put(path, response);
			} catch {
				// This script is given up on - a failed or stalled download, or a full disk. It is tried again after
				// activation, and the first question asked online fetches it if that misses too.
			}
		}
	} finally {
		clearTimeout(timer);
	}
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
 * APP_SHELL is the exception: a held copy stands. Install stored it from its own release, and a visit during an
 * update fetches the next release's page, which in this cache would name files the cache does not hold. With none
 * held - after an erase - the visit keeps one.
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
	const copy = response.clone();
	const keepHeld = new URL(request.url).pathname === APP_SHELL;
	event.waitUntil(
		(async () => {
			if (keepHeld && (await cache.match(APP_SHELL, { ignoreVary: true })) !== undefined) return;
			await cache.put(request, copy);
		})().catch(() => {})
	);
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

/**
 * The page the service worker keeps at install, in the same cache as the app's code. Every page that shows
 * personal data renders in the browser (`ssr = false`), so this is the app's frame with nothing of the user's in
 * it: served for any top-level address, the router draws that page. Each release's install keeps its own copy
 * while online, so a page still opens offline after an update deletes the previous release's cache - and after a
 * first visit, whose own page load came before the worker could keep it.
 */
export const APP_SHELL = '/';

/**
 * The pages install keeps beside the build files. One list, read by the worker and by the precache budget, so a
 * page kept at install is always counted.
 */
export const INSTALL_PAGES: readonly string[] = [APP_SHELL];

/**
 * What the service worker answers from its cache when the network fails.
 *
 * A request gets the copy kept for it. A navigation with none - a page never opened while the worker was in
 * charge, or any page after an update - gets APP_SHELL, which draws it. The shell loads its code by relative
 * paths, so this holds for top-level addresses only; `src/lib/ci/offline-shell-policy.test.ts` fails if a nested
 * page route is added.
 *
 * @param cache The cache the request would be kept in.
 * @param request The request that failed on the network.
 * @returns The kept response, or undefined when there is none.
 */
export async function offlineResponse(
	cache: Pick<Cache, 'match'>,
	request: Request
): Promise<Response | undefined> {
	const kept = await cache.match(request);
	if (kept !== undefined || request.mode !== 'navigate') return kept;
	// Top-level addresses only: from anywhere deeper the shell's relative paths miss, and it opens blank.
	if (!/^\/[^/]*$/.test(new URL(request.url).pathname)) return undefined;
	// ignoreVary: install stored the shell under its own request, not under a navigation's headers.
	return cache.match(APP_SHELL, { ignoreVary: true });
}
