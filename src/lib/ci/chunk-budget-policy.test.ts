import { describe, it, expect } from 'vitest';
import { precachedPaths, splitChunksByLoading, type BuildManifest } from './chunk-budget-policy';

// The shape of the real Vite manifest SvelteKit writes: the app entry and every route node are marked
// `isEntry`; a component loaded with import() is `isDynamicEntry`, and so is the library it loads the same way.
const MANIFEST: BuildManifest = {
	'app.js': {
		file: '_app/immutable/entry/app.A.js',
		isEntry: true,
		imports: ['_shared.js'],
		dynamicImports: ['nodes/0.js', 'nodes/1.js']
	},
	'nodes/0.js': {
		file: '_app/immutable/nodes/0.B.js',
		isEntry: true,
		imports: ['_shared.js', '_layout.js']
	},
	'nodes/1.js': { file: '_app/immutable/nodes/1.C.js', isEntry: true, imports: ['_reader.js'] },
	'_shared.js': { file: '_app/immutable/chunks/shared.D.js' },
	'_layout.js': { file: '_app/immutable/chunks/layout.E.js', imports: ['_deep.js'] },
	'_deep.js': { file: '_app/immutable/chunks/deep.F.js' },
	'_reader.js': { file: '_app/immutable/chunks/reader.G.js', dynamicImports: ['Viewer.svelte'] },
	'Viewer.svelte': {
		file: '_app/immutable/chunks/viewer.H.js',
		isDynamicEntry: true,
		imports: ['_shared.js', '_viewerdep.js'],
		dynamicImports: ['pdf.mjs']
	},
	'_viewerdep.js': { file: '_app/immutable/chunks/viewerdep.I.js' },
	'pdf.mjs': { file: '_app/immutable/chunks/pdf.J.js', isDynamicEntry: true },
	'style.css': { file: '_app/immutable/assets/style.K.css' }
};

describe('splitChunksByLoading', () => {
	it('counts every chunk an entry or route node reaches by static import as page-loaded', () => {
		expect(splitChunksByLoading(MANIFEST).page).toEqual([
			'_app/immutable/chunks/deep.F.js',
			'_app/immutable/chunks/layout.E.js',
			'_app/immutable/chunks/reader.G.js',
			'_app/immutable/chunks/shared.D.js'
		]);
	});

	// Reached only through import(), a chunk is fetched when code asks for it - the viewer when a document
	// is opened - together with its own static imports, which no page load pulls in.
	it('counts a chunk reached only through a dynamic import as on demand, with its static imports', () => {
		expect(splitChunksByLoading(MANIFEST).onDemand).toEqual([
			'_app/immutable/chunks/pdf.J.js',
			'_app/immutable/chunks/viewer.H.js',
			'_app/immutable/chunks/viewerdep.I.js'
		]);
	});

	it('counts a chunk reached both ways as page-loaded, never twice', () => {
		const { page, onDemand } = splitChunksByLoading(MANIFEST);
		expect(page).toContain('_app/immutable/chunks/shared.D.js');
		expect(onDemand).not.toContain('_app/immutable/chunks/shared.D.js');
	});

	// Entries and route nodes carry their own size budgets; this one is for the shared chunks only.
	it('lists chunks only - never an entry, a route node or a stylesheet', () => {
		const { page, onDemand } = splitChunksByLoading(MANIFEST);
		for (const file of [...page, ...onDemand]) {
			expect(file.startsWith('_app/immutable/chunks/')).toBe(true);
		}
	});

	// A manifest that names an import it does not describe cannot be budgeted honestly: every chunk behind
	// that import would silently drop out of the page budget.
	it('fails closed on an import the manifest does not describe', () => {
		const broken: BuildManifest = {
			...MANIFEST,
			'nodes/0.js': { file: '_app/immutable/nodes/0.B.js', isEntry: true, imports: ['_missing.js'] }
		};
		expect(() => splitChunksByLoading(broken)).toThrow('E_CHUNK_BUDGET_MANIFEST');
	});
});

// The head of a real built service worker, cut to a few entries per list: SvelteKit reads a base path from the
// worker's own location, then writes its `build` list and its `files` list, each entry prefixed with that base.
// The template strings after them are the worker's own code - the asset rules' prefixes - and name no asset.
const WORKER =
	'var e=location.pathname.split(`/`).slice(0,-1).join(`/`),' +
	't=[e+`/_app/immutable/entry/app.CGWxtLHK.js`,e+`/_app/immutable/nodes/0.BBKT8Lpe.js`,' +
	'e+`/_app/immutable/assets/0.DjlkDVm5.css`],' +
	'n=[e+`/.well-known/security.txt`,e+`/corpus/corpus-v1.0.2.json`,e+`/docs/tap_dol_efct.6dbd2705.pdf`,' +
	'e+`/models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json`,e+`/pdf-worker/6.3.289/pdf.min.mjs`,' +
	'e+`/robots.txt`,e+`/wasm/ort-wasm-simd-threaded.wasm`],r=`1790302866627`;' +
	'function i(e){return e.startsWith(`/models/`)||e.startsWith(`/wasm/`)}';

describe('precachedPaths', () => {
	it('reads every path the worker lists, build files and static files alike', () => {
		expect(precachedPaths(WORKER).listed).toEqual([
			'/_app/immutable/entry/app.CGWxtLHK.js',
			'/_app/immutable/nodes/0.BBKT8Lpe.js',
			'/_app/immutable/assets/0.DjlkDVm5.css',
			'/.well-known/security.txt',
			'/corpus/corpus-v1.0.2.json',
			'/docs/tap_dol_efct.6dbd2705.pdf',
			'/models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json',
			'/pdf-worker/6.3.289/pdf.min.mjs',
			'/robots.txt',
			'/wasm/ort-wasm-simd-threaded.wasm'
		]);
	});

	// The worker downloads its precache at install, for every visitor; the rest it keeps only once fetched.
	it('keeps for the precache only what the worker installs with, never a lazy asset', () => {
		expect(precachedPaths(WORKER).precached).toEqual([
			'/_app/immutable/entry/app.CGWxtLHK.js',
			'/_app/immutable/nodes/0.BBKT8Lpe.js',
			'/_app/immutable/assets/0.DjlkDVm5.css',
			'/.well-known/security.txt',
			'/robots.txt'
		]);
	});

	// The bundler names the base whatever it likes. Only strings prefixed with THAT name are list entries; a path
	// the worker's own code builds from another value is not an asset.
	it('reads the base name from the worker itself, and nothing prefixed with another name', () => {
		const renamed =
			WORKER.replaceAll('e+`', 'a+`').replace('var e=', 'var a=') + 'o+`/api/retrieve`';
		expect(precachedPaths(renamed).listed).toEqual(precachedPaths(WORKER).listed);
	});

	// A worker written in another shape must stop the gate, not read as an empty precache that passes.
	it('refuses a worker whose base path it cannot find', () => {
		expect(() =>
			precachedPaths('self.addEventListener(`install`,()=>{}),n=[a+`/robots.txt`]')
		).toThrow('E_PRECACHE_LIST_UNREADABLE');
	});
});
