import { describe, it, expect } from 'vitest';
import {
	kilobytes,
	precachedPaths,
	roomInBytes,
	splitChunksByLoading,
	strayWasm,
	unreadWorkerScripts,
	type BuildManifest
} from './chunk-budget-policy';

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

// The worker's script is left out of the build list, so install finds it only by reading its name from the built
// code. A script the reading misses would silently stop being kept for a set-up device, so the build fails on it.
describe('unreadWorkerScripts', () => {
	const SCRIPT = '/_app/immutable/workers/embed-worker-BIZt0I_P.js';

	it('passes when every script in the build is named by the built code', () => {
		expect(unreadWorkerScripts([SCRIPT], [SCRIPT])).toEqual([]);
	});

	// The app always ships the embed worker. A build with no script on disk - the worker renamed, or moved out of the
	// folder - has nothing to check, and must not read as a pass.
	it('fails closed when no script is on disk, whatever the built code names', () => {
		expect(() => unreadWorkerScripts([], [])).toThrow('E_WORKER_SCRIPT_NONE');
		expect(() => unreadWorkerScripts([SCRIPT], [])).toThrow('E_WORKER_SCRIPT_NONE');
	});

	// The built code naming nothing leaves every script on disk unkept: the reading is broken, so each is returned.
	it('returns every script on disk when the built code names none', () => {
		expect(unreadWorkerScripts([], [SCRIPT])).toEqual([SCRIPT]);
	});

	it('returns a script in the build that no built code names', () => {
		expect(unreadWorkerScripts([], [SCRIPT])).toEqual([SCRIPT]);
		const other = '/_app/immutable/workers/other-Q9.js';
		expect(unreadWorkerScripts([SCRIPT], [SCRIPT, other])).toEqual([other]);
	});

	// A worker's split code is written below the worker folder. Install would not keep it, and it can never be named
	// the way a script directly in the folder is, so its presence alone must fail the build.
	it('returns a script in a subfolder of the worker folder, which no built code can name', () => {
		const split = '/_app/immutable/workers/chunks/shared-Z3.js';
		expect(unreadWorkerScripts([SCRIPT], [SCRIPT, split])).toEqual([split]);
	});
});

// The worker loads its WASM from the vendored /wasm/ folder. A copy the bundler writes anywhere else is never
// requested, and is the largest file in the build.
describe('strayWasm', () => {
	it('passes a build whose only WASM is in the vendored folder', () => {
		expect(
			strayWasm([
				'wasm/ort-wasm-simd-threaded.asyncify.mjs',
				'wasm/ort-wasm-simd-threaded.asyncify.wasm',
				'_app/immutable/workers/embed-worker-BIZt0I_P.js'
			])
		).toEqual([]);
	});

	it('returns a WASM file the bundler wrote outside the vendored folder', () => {
		const copy = '_app/immutable/workers/assets/ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm';
		expect(strayWasm(['wasm/ort-wasm-simd-threaded.asyncify.wasm', copy])).toEqual([copy]);
	});

	it('does not take a folder that merely starts with the name for the vendored one', () => {
		expect(strayWasm(['wasmish/x.wasm', '_app/wasm/x.wasm'])).toEqual([
			'wasmish/x.wasm',
			'_app/wasm/x.wasm'
		]);
	});
});

// A budget line prints the size and its limit the same way, so a size at or under the limit never reads as over it:
// a limit rounded to whole kilobytes would read "135.11 KB <= 135 KB" for a build that passes.
describe('kilobytes', () => {
	it('prints metric kilobytes to two places, the same for a size and for a limit', () => {
		expect(kilobytes(55_930)).toBe('55.93');
		expect(kilobytes(56_000)).toBe('56.00');
		expect(kilobytes(135_200)).toBe('135.20');
		expect(kilobytes(7_300)).toBe('7.30');
	});

	it('keeps a limit that is not a whole kilobyte apart from the whole kilobyte below it', () => {
		expect(kilobytes(135_112)).toBe('135.11');
		expect(kilobytes(135_000)).not.toBe(kilobytes(135_112));
	});
});

// Two decimals of a kilobyte hide up to 4 B, so a row's kilobytes alone can read "147.20 KB <= 147.20 KB" for a size
// that is over. The row states its room or its shortfall in whole bytes beside them.
describe('roomInBytes', () => {
	it('states the bytes of room under the limit', () => {
		expect(roomInBytes(147_126, 147_200)).toBe('74 B to spare');
	});

	it('states no room, and not an overage, for a size exactly at the limit', () => {
		expect(roomInBytes(147_200, 147_200)).toBe('0 B to spare');
	});

	it('states a single byte over, which the kilobytes of that row print as equal', () => {
		expect(kilobytes(147_201)).toBe(kilobytes(147_200));
		expect(roomInBytes(147_201, 147_200)).toBe('1 B over');
	});

	it('states the measured shortfall for a larger overage', () => {
		expect(roomInBytes(147_203, 147_200)).toBe('3 B over');
		expect(roomInBytes(150_200, 147_200)).toBe('3,000 B over');
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
	'e+`/robots.txt`,e+`/wasm/ort-wasm-simd-threaded.asyncify.wasm`],r=`1790302866627`;' +
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
			'/wasm/ort-wasm-simd-threaded.asyncify.wasm'
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
