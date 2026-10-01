// Relative, not `$lib`: the budget script imports this module under tsx, which does not resolve the alias.
import { classifyAsset } from '../ask/asset-cache';

/** One file in the Vite build manifest, keyed there by its source; only the fields the split reads. */
export type ManifestChunk = {
	file: string;
	isEntry?: boolean;
	isDynamicEntry?: boolean;
	imports?: string[];
	dynamicImports?: string[];
};

export type BuildManifest = Record<string, ManifestChunk>;

const CHUNKS = '_app/immutable/chunks/';

/**
 * Split the built shared chunks by how they load: those a page downloads, and those fetched only on demand.
 *
 * A single summed chunk budget cannot tell the two apart, so code that loads only when asked - the PDF
 * viewer, when someone opens a document - counts against every page load and fails a budget whose purpose
 * is what a visitor downloads. The split reads the bundler's own record of each import rather than parsing
 * the minified output.
 *
 * A page downloads its entries - SvelteKit marks the app entry and every route node `isEntry` - and everything
 * they reach by STATIC import. A chunk reached only through a dynamic import is on demand, with its own
 * static imports. A chunk reached both ways is page-loaded, and never counted twice.
 *
 * @param manifest The Vite build manifest SvelteKit writes for the client.
 * @returns The chunk files in each set, sorted; entries, route nodes and stylesheets are in neither.
 * @throws Error `E_CHUNK_BUDGET_MANIFEST` when an import names a file the manifest does not describe. Every
 *   chunk behind it would silently drop out of the page budget, so the check fails closed instead.
 */
export function splitChunksByLoading(manifest: BuildManifest): {
	page: string[];
	onDemand: string[];
} {
	const reached = new Set<string>();
	const stack = Object.keys(manifest).filter((key) => manifest[key]?.isEntry === true);
	while (stack.length > 0) {
		const key = stack.pop() as string;
		if (reached.has(key)) continue;
		const chunk = manifest[key];
		if (chunk === undefined) throw new Error('E_CHUNK_BUDGET_MANIFEST');
		reached.add(key);
		stack.push(...(chunk.imports ?? []));
	}

	const page = new Set([...reached].map((key) => manifest[key]?.file ?? ''));
	const chunks = [...new Set(Object.values(manifest).map((chunk) => chunk.file))].filter(
		(file) => file.startsWith(CHUNKS) && file.endsWith('.js')
	);
	return {
		page: chunks.filter((file) => page.has(file)).sort(),
		onDemand: chunks.filter((file) => !page.has(file)).sort()
	};
}

/**
 * The paths a built service worker installs from, read from the worker itself.
 *
 * SvelteKit writes the worker's `build` and `files` lists into it as template strings, each prefixed with a
 * base path the worker reads from its own location. That base is found first, so only list entries are read
 * and never another string in the worker's code; the precache is then filtered by the rule the worker itself
 * applies, so the two cannot disagree about what a visitor downloads at install.
 *
 * @param workerSource The built service worker's text.
 * @returns Every listed path, and the ones the worker precaches at install.
 * @throws E_PRECACHE_LIST_UNREADABLE when the worker's base path cannot be found.
 */
export function precachedPaths(workerSource: string): { listed: string[]; precached: string[] } {
	const base = /([A-Za-z_$][\w$]*)=location\.pathname\.split\(/.exec(workerSource)?.[1];
	if (base === undefined) throw new Error('E_PRECACHE_LIST_UNREADABLE');
	const listed = [
		...new Set(
			[...workerSource.matchAll(/([A-Za-z_$][\w$]*)\+`(\/[^`]+)`/g)]
				.filter((match) => match[1] === base)
				.map((match) => match[2] as string)
		)
	];
	return { listed, precached: listed.filter((path) => classifyAsset(path) === 'precache') };
}

/**
 * The worker scripts in the build that install cannot find.
 *
 * Install keeps the embed worker's script for a device that set up on-device answers, reading its name from the
 * built page code (`workerScriptsNamed`) because SvelteKit's build list leaves worker scripts out. A bundler
 * change that writes the name another way would leave the script unkept, and nothing would fail until a device
 * asked its first question offline after an update. Comparing what the reading finds with what the build wrote to
 * disk turns that into a failed build.
 *
 * @param named The worker script pathnames the reading found in the built code.
 * @param onDisk Every `.js` file the build wrote under the worker folder, subfolders included, as pathnames
 *   served from the site root. A worker's split code is written to a subfolder, and only a script directly in
 *   the folder can be found by name, so one in a subfolder is always returned.
 * @returns Every script on disk that the reading did not find; all of them when the built code names none.
 * @throws Error `E_WORKER_SCRIPT_NONE` when no script is on disk. The app always ships the embed worker, so an
 *   empty folder means the worker was renamed or moved out of it, and a check with nothing to check would read
 *   as a pass while the script stopped being kept.
 */
export function unreadWorkerScripts(named: readonly string[], onDisk: readonly string[]): string[] {
	if (onDisk.length === 0) throw new Error('E_WORKER_SCRIPT_NONE');
	return onDisk.filter((script) => !named.includes(script));
}

/**
 * The WebAssembly files in the build output that are not in the `/wasm/` folder.
 *
 * The embed worker sets `wasmPaths = '/wasm/'`, so the runtime loads its WASM from the vendored folder and from
 * nowhere else. The runtime library inside the worker also names a copy of it as a fallback for when `wasmPaths`
 * is unset, and the bundler writes that copy - about 23 MB - next to the worker's script, where nothing ever
 * requests it and every release would ship it. Any WASM outside the vendored folder is that, or a new one nothing
 * has decided to ship.
 *
 * @param files Every file the build wrote, as paths relative to the client output (`wasm/x.wasm`).
 * @returns The `.wasm` files not under `wasm/`.
 */
export function strayWasm(files: readonly string[]): string[] {
	return files.filter((file) => file.endsWith('.wasm') && !file.startsWith('wasm/'));
}

/**
 * A byte count as metric kilobytes (1 KB = 1,000 B) to two places.
 *
 * A budget line prints its size and its limit through this one function, so both carry the same precision: a
 * limit rounded to whole kilobytes beside a size in hundredths would show a passing size as over its limit
 * ("135.11 KB <= 135 KB") and could misstate a real shortfall by up to 499 B.
 */
export function kilobytes(bytes: number): string {
	return (bytes / 1000).toFixed(2);
}

/**
 * What a budget row has left, or is short, in whole bytes.
 *
 * Two decimals of a kilobyte hide a few bytes (up to 5 B: 7,305 B prints as 7.30 KB): a size 1 B over its limit
 * prints as `147.20 KB <= 147.20 KB`. The
 * row states the exact figure beside them, so a shortfall is always shown as measured.
 *
 * @param size The measured bytes.
 * @param limit The budgeted bytes.
 * @returns `74 B to spare` at or under the limit (`0 B to spare` exactly at it), `3 B over` above it.
 */
export function roomInBytes(size: number, limit: number): string {
	const bytes = (count: number) => count.toLocaleString('en-US');
	return size <= limit ? `${bytes(limit - size)} B to spare` : `${bytes(size - limit)} B over`;
}

/**
 * The page the service worker also keeps at install (APP_SHELL in ../ask/asset-cache): a served page, not a file
 * in the build, so the budget cannot weigh it on disk. This is its allowance in gzip-9 bytes; the offline-pages
 * E2E weighs the real page against it. Measured 1,469 B (that E2E, gzip-9 of the kept body) on 2026-09-26.
 */
export const SHELL_BYTES_ALLOWANCE = 1_600;
