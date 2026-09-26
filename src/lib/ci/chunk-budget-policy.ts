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
