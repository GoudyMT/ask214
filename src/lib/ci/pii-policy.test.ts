import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
	BYO_KEY_PATTERNS,
	FORBIDDEN_PII_PATTERNS,
	PII_FIELD_NAMES,
	scanForPiiImports,
	scanForPiiTokens
} from './pii-policy';

const LF = String.fromCharCode(10);

// Server-side SvelteKit source: anything that can execute on a server - a route's server file, hooks, any `server`
// or `*.server` module and everything in a `server` folder outside src/routes, the rule SvelteKit itself applies. The
// feedback endpoint is the one today; the guard covers it and any added later (PII stays on device).
const SERVER_FILE_PATTERN = /[\\/+.]server\.[cm]?[jt]s$/;
const SERVER_FOLDER_PATTERN = /[\\/]src[\\/](?!routes[\\/])(?:.*[\\/])?server[\\/]/;

/** Whether a file in a scanned folder is source the guard reads: every kind, tests and type declarations aside. */
function isScannedSource(name: string): boolean {
	return (
		/\.(?:[cm]?[jt]s|svelte)$/.test(name) &&
		!/\.test\.[cm]?[jt]s$/.test(name) &&
		!/\.d\.[cm]?ts$/.test(name)
	);
}

/** Whether a source file runs on the server. */
function isServerSource(path: string): boolean {
	return (
		(SERVER_FILE_PATTERN.test(path) || SERVER_FOLDER_PATTERN.test(`/${path}`)) &&
		isScannedSource(basename(path))
	);
}

/** Recursively collect server-side source files under a directory. */
function findServerFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...findServerFiles(full));
		} else if (isServerSource(full)) {
			out.push(full);
		}
	}
	return out;
}

describe('pii-policy: what the guard reads', () => {
	// SvelteKit runs these on the server only: a file named `server.*` or `*.server.*`, and anything in a `server`
	// folder outside src/routes.
	it('counts every server-only file: server and *.server modules, and any server folder', () => {
		expect(isServerSource(join('src', 'routes', 'api', 'feedback', '+server.ts'))).toBe(true);
		expect(isServerSource(join('src', 'lib', 'resend.server.ts'))).toBe(true);
		expect(isServerSource(join('src', 'lib', 'mail', 'server.ts'))).toBe(true);
		expect(isServerSource(join('src', 'lib', 'server', 'mailer.ts'))).toBe(true);
		expect(isServerSource(join('src', 'lib', 'mail', 'server', 'format.ts'))).toBe(true);
		expect(isServerSource(join('src', 'server', 'mailer.ts'))).toBe(true);
		expect(isServerSource(join('src', 'lib', 'server', 'mailer.test.ts'))).toBe(false);
		expect(isServerSource(join('src', 'routes', 'api', 'feedback', 'server.test.ts'))).toBe(false);
		expect(isServerSource(join('src', 'lib', 'ask', 'store.svelte.ts'))).toBe(false);
		expect(isServerSource(join('src', 'lib', 'ask', 'observer.ts'))).toBe(false);
	});

	it('skips build output: dot folders and node_modules', () => {
		const root = mkdtempSync(join(tmpdir(), 'pii-scope-'));
		try {
			for (const rel of [
				'unit.ts',
				join('.wrangler', 'bundle.js'),
				join('node_modules', 'dep.js')
			]) {
				mkdirSync(dirname(join(root, rel)), { recursive: true });
				writeFileSync(join(root, rel), '');
			}
			expect(findSourceFiles(root).map((p) => basename(p))).toEqual(['unit.ts']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('reads every source kind in a scanned folder, not only .ts', () => {
		expect(isScannedSource('Panel.svelte')).toBe(true);
		expect(isScannedSource('helper.js')).toBe(true);
		expect(isScannedSource('unit.ts')).toBe(true);
		for (const name of ['worker.mjs', 'build.cjs', 'unit.mts', 'unit.cts']) {
			expect(isScannedSource(name), name).toBe(true);
		}
		expect(isScannedSource('unit.test.mjs')).toBe(false);
		expect(isScannedSource('types.d.mts')).toBe(false);
		expect(isScannedSource('unit.test.ts')).toBe(false);
		expect(isScannedSource('Panel.svelte.test.ts')).toBe(false);
		expect(isScannedSource('types.d.ts')).toBe(false);
	});
});

describe('pii-policy: server source must not reference ProfileV1 PII fields', () => {
	it('flags a planted PII token in a server file', () => {
		const violations = scanForPiiTokens([
			{ path: 'src/routes/x/+server.ts', content: 'const v = profile.eaos;' }
		]);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.token).toBe('\\.eaos\\b');
	});

	it('flags the leaving answer, which can say a member faces a medical board', () => {
		const violations = scanForPiiTokens([
			{ path: 'src/routes/x/+server.ts', content: 'const v = persona.separationPath;' }
		]);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.token).toBe('\\.separationPath\\b');
	});

	it.each(['skillbridgeStart', 'terminalLeaveStart'])('flags the leaving date %s', (field) => {
		const violations = scanForPiiTokens([
			{ path: 'src/routes/x/+server.ts', content: `const v = persona.leaving.${field};` }
		]);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.token).toBe(`\\.${field}\\b`);
	});

	it.each(['lastBackupAt', 'backupGenProfile', 'backupGenTimeline', 'backupGenCalendar'])(
		'flags the backup mark %s',
		(field) => {
			const violations = scanForPiiTokens([
				{ path: 'src/routes/x/+server.ts', content: `const v = profile.${field};` }
			]);
			expect(violations).toHaveLength(1);
			expect(violations[0]?.token).toBe(`\\.${field}\\b`);
		}
	);

	it('does not flag clean server code', () => {
		const violations = scanForPiiTokens([
			{ path: 'src/routes/x/+server.ts', content: 'export const GET = () => new Response("ok");' }
		]);
		expect(violations).toEqual([]);
	});

	it('does not flag a word that merely contains a field name', () => {
		// `.rateLimit` must not match the `.rate\b` pattern.
		const violations = scanForPiiTokens([
			{ path: 'src/hooks.server.ts', content: 'const x = limiter.rateLimit;' }
		]);
		expect(violations).toEqual([]);
	});

	it('the real server-side source tree contains no PII tokens', () => {
		const serverFiles = findServerFiles(join(process.cwd(), 'src'));
		const files = serverFiles.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
		expect(scanForPiiTokens(files)).toEqual([]);
	});
});

// The online path (the server-side retrieve Worker + the client egress + synthesis units) is the only code
// that can send a request off-device. Beyond the runtime structural allowlist (assertOnlyKeys), this
// statically forbids any profile PII field or the keystore install identifier from being named there.
const ONLINE_PATH_DIRS = ['src/lib/ask/online', 'src/lib/ask/synthesis', 'workers/retrieve'];
// The Ask store and the home route build the egress closures (retrieveOnline/synthesize), so a PII field
// named there would ride into an off-device request just like one in the units above. They are single files,
// not directory trees, so the guard names them explicitly.
const ONLINE_PATH_FILES = ['src/lib/ask/store.svelte.ts', 'src/routes/+page.svelte'];
// The feedback form sends its message to the server's feedback endpoint, so it is an off-device path too.
const FEEDBACK_PATH_DIRS = ['src/lib/feedback'];
const FEEDBACK_PATH_FILES = [
	'src/lib/components/FeedbackForm.svelte',
	'src/routes/feedback/+page.svelte',
	'src/routes/feedback/+page.ts'
];

/** Recursively collect the non-test, non-generated source files under a directory, skipping build output (dot
 *  folders such as the Worker's .wrangler, and node_modules). */
function findSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
			out.push(...findSourceFiles(full));
		} else if (isScannedSource(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

/** Every path in the online-egress guard's scope: the directory trees plus the explicitly-named files. */
function collectOnlinePathFiles(): string[] {
	return [
		...[...ONLINE_PATH_DIRS, ...FEEDBACK_PATH_DIRS].flatMap((dir) =>
			findSourceFiles(join(process.cwd(), dir))
		),
		...[...ONLINE_PATH_FILES, ...FEEDBACK_PATH_FILES].map((file) => join(process.cwd(), file))
	];
}

describe('pii-policy: the online egress path must not name PII or the install identifier', () => {
	it('flags the keystore install identifier', () => {
		const violations = scanForPiiTokens([
			{ path: 'src/lib/ask/online/x.ts', content: 'body.id = keystore.installUuid;' }
		]);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.token).toBe('\\binstallUuid\\b');
	});

	it('the guard covers the Ask store and the home route that build the egress closures', () => {
		const scanned = collectOnlinePathFiles();
		expect(scanned.some((p) => p.endsWith(join('ask', 'store.svelte.ts')))).toBe(true);
		expect(scanned.some((p) => p.endsWith(join('routes', '+page.svelte')))).toBe(true);
	});

	it('the guard covers the feedback form, its route and its library', () => {
		const scanned = collectOnlinePathFiles();
		expect(scanned.some((p) => p.endsWith(join('components', 'FeedbackForm.svelte')))).toBe(true);
		expect(scanned.some((p) => p.endsWith(join('routes', 'feedback', '+page.svelte')))).toBe(true);
		expect(scanned.some((p) => p.endsWith(join('lib', 'feedback', 'compose.ts')))).toBe(true);
	});

	it('the real online-path source contains no PII tokens', () => {
		const files = collectOnlinePathFiles().map((path) => ({
			path,
			content: readFileSync(path, 'utf8')
		}));
		expect(scanForPiiTokens(files)).toEqual([]);
	});
});

describe('pii-policy: a profile field read without a dot', () => {
	const scan = (content: string) =>
		scanForPiiTokens([{ path: 'src/routes/x/+server.ts', content }]);

	it.each(PII_FIELD_NAMES)('flags %s read by bracket', (field) => {
		expect(scan(`const v = profile['${field}'];`)).not.toEqual([]);
		expect(scan(`const v = profile[\`${field}\`];`)).not.toEqual([]);
	});

	it.each(PII_FIELD_NAMES)('flags %s destructured on one line', (field) => {
		expect(scan(`const { a, ${field} } = profile;`)).not.toEqual([]);
	});

	// "rate" and "rank" are ordinary words, and a wrapped line of prose can start with one, so the multi-line form leaves
	// them to the online request test (tests/e2e/egress-canary.e2e.ts), which checks the values that leave the device -
	// once a screen sets them and that test seeds them; none does yet.
	const ORDINARY_WORDS = ['rate', 'rank'];

	it.each(PII_FIELD_NAMES.filter((field) => !ORDINARY_WORDS.includes(field)))(
		'flags %s destructured over several lines',
		(field) => {
			expect(scan(['const {', '\ta,', `\t${field}`, '} = profile;'].join('\n'))).not.toEqual([]);
		}
	);

	it('every dot pattern names a field in PII_FIELD_NAMES, and every field has one', () => {
		const dotted = FORBIDDEN_PII_PATTERNS.map((p) => /^\\\.(\w+)\\b$/.exec(p.source)?.[1]).filter(
			(name): name is string => name !== undefined
		);
		expect([...dotted].sort()).toEqual([...PII_FIELD_NAMES].sort());
	});

	it('leaves prose that lists a field name, and longer names, alone', () => {
		expect(scan('// never present a figure, rate, or deadline as current')).toEqual([]);
		expect(scan('const { rateLimit } = cfg;')).toEqual([]);
		expect(scan('// the rank of each result')).toEqual([]);
		expect(
			scan(['const p = `never present a figure,', 'rate, or deadline as current`;'].join('\n'))
		).toEqual([]);
	});
});

describe('pii-policy: off-device code must not import the personal-data modules', () => {
	const scan = (content: string) =>
		scanForPiiImports([{ path: 'src/lib/ask/online/x.ts', content }]);

	// The scan knows one alias, `#lib/`. A second alias added to package.json (say `#data/*` for src/lib/profile) would
	// reach a banned folder by a name the scan never reads, so the map is pinned here: a new alias changes this guard too.
	it('reads the only import aliases package.json defines', () => {
		const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
			imports?: Record<string, string>;
		};
		expect(pkg.imports).toEqual({ '#lib': './src/lib/index.js', '#lib/*': './src/lib/*' });
		expect(scan("import { a } from '#lib/profile/x';")).toHaveLength(1);
	});

	it.each([
		'#lib/profile/store.svelte.js',
		'../../profile/codec',
		'#lib/keystore/record.js',
		'#lib/timeline/state.svelte.js',
		'#lib/calendar/store.svelte.js',
		'#lib/db/schema.js',
		'#lib/crypto/aes-gcm.js',
		'#lib/backup/session.svelte.js',
		'../../../src/lib/profile/types'
	])('flags an import of %s', (specifier) => {
		const violations = scan(`import { a } from '${specifier}';`);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.token).toBe(specifier);
	});

	it('flags a dynamic import, a side-effect import and an import split over several lines', () => {
		expect(scan(`const m = await import('#lib/profile/store.svelte');`)).toHaveLength(1);
		expect(scan(`import '#lib/keystore/record';`)).toHaveLength(1);
		expect(
			scan(['import {', '\ta,', '\tb', "} from '#lib/profile/codec';"].join('\n'))
		).toHaveLength(1);
	});

	it('flags the other ways to spell the same import', () => {
		expect(scan('const m = await import(`#lib/profile/store.svelte`);')).toHaveLength(1);
		expect(scan("import { a } from '#lib/ask/../profile/persona';")).toHaveLength(1);
		expect(scan("import { a } from '/src/lib/profile/persona';")).toHaveLength(1);
		expect(
			scan(['const m = await import(', "\t'#lib/profile/store.svelte'", ');'].join('\n'))
		).toHaveLength(1);
	});

	it('flags an import with a bundler comment before its specifier, on the line it starts', () => {
		expect(scan("const m = import(/* @vite-ignore */ '#lib/profile/store.svelte');")).toHaveLength(
			1
		);
		const found = scan(
			['', 'import(', '\t/** @vite-ignore */', '\t`#lib/keystore/x`', ')'].join('\n')
		);
		expect(found).toMatchObject([{ token: '#lib/keystore/x', line: 2 }]);
	});

	it.each([
		["import (/* @vite-ignore */ '#lib/profile/x');"],
		[['import(', "// don't bundle this", "/* c */ '#lib/profile/x'", ')'].join(LF)],
		["import /* c */ ('#lib/profile/x');"],
		["import { a } from /* c */ '#lib/profile/x';"],
		["import /* c */ '#lib/profile/x';"],
		["import.meta.glob(/* c */ '/src/lib/profile/*.ts');"],
		["import.meta.glob([/* c */ '/src/lib/profile/*.ts']);"],
		["import.meta.glob(/* c */ ['/src/lib/profile/*.ts']);"],
		["import(/* @vite-ignore */ dev ? '#lib/profile/x' : './y');"],
		["import(/* c */ base + '#lib/profile/x');"],
		["import(/* c */ ('#lib/profile/x'));"],
		["run('from', () => import(/* c */ '#lib/keystore/y'));"],
		["const k = { t: 'import', load: () => import(/* c */ '#lib/profile/x') };"],
		["import(/* it's \"quoted\" */ '#lib/profile/x');"]
	])('reads past any comment in %s', (content) => {
		expect(scan(content)).toHaveLength(1);
	});

	// A glob can take a type argument, and its list can name the banned folder in any item, not only the first.
	it.each([
		["import.meta.glob<M>('/src/lib/profile/*.ts');", ['/src/lib/profile/*.ts']],
		[
			"import.meta.globEager<Record<string, M>>( '/src/lib/keystore/*.ts');",
			['/src/lib/keystore/*.ts']
		],
		[
			"import.meta.glob(['/src/lib/ask/*.ts', '/src/lib/profile/*.ts']);",
			['/src/lib/profile/*.ts']
		],
		[
			[
				'import.meta.glob<M>([',
				"\t'/src/lib/ask/*.ts',",
				'\t// the keys',
				"\t'#lib/keystore/*.ts'",
				'])'
			].join(LF),
			['#lib/keystore/*.ts']
		],
		[
			"import.meta.glob(['/src/lib/profile/*.ts', /* c */ '/src/lib/db/*.ts'], { eager: true });",
			['/src/lib/profile/*.ts', '/src/lib/db/*.ts']
		],
		// A close bracket inside an item or a comment does not end the list.
		["import.meta.glob(['./a/*.[jt]s', '$lib/profile/*.ts']);", ['$lib/profile/*.ts']],
		[
			['import.meta.glob([', "\t'./a/*.ts', // see [1]", "\t'$lib/profile/*.ts'", '])'].join(LF),
			['$lib/profile/*.ts']
		],
		// A type argument may hold parentheses, and an item may hold the other kind of quote.
		["import.meta.glob<() => Promise<string>>('$lib/profile/*.ts');", ['$lib/profile/*.ts']],
		["import.meta.glob([\"./it's/*.ts\", '$lib/profile/*.ts']);", ['$lib/profile/*.ts']],
		// A folder named by a pattern, or a base folder, can reach a banned folder under no name the scan can read.
		["import.meta.glob('/src/lib/**/*.ts', { eager: true });", ['/src/lib/**/*.ts']],
		["import.meta.glob('/src/lib/{ask,profile}/*.ts');", ['/src/lib/{ask,profile}/*.ts']],
		["import.meta.glob('/src/lib/prof*/*.ts');", ['/src/lib/prof*/*.ts']],
		["import.meta.glob(['./routes/[id]/*.ts']);", ['./routes/[id]/*.ts']],
		["import.meta.glob('./*.ts', { base: '/src/lib/profile' });", ['/src/lib/profile']]
	])('flags each banned item of the glob %s', (content, tokens) => {
		expect(scan(content).map((v) => v.token)).toEqual(tokens);
	});

	it('names the line of a later glob item', () => {
		const content = [
			'import.meta.glob([',
			"\t'/src/lib/ask/*.ts',",
			"\t'/src/lib/profile/*.ts'",
			'])'
		].join(LF);
		expect(scan(content)).toMatchObject([{ token: '/src/lib/profile/*.ts', line: 3 }]);
	});

	it('leaves a glob of allowed folders, and a plain list of strings, alone', () => {
		expect(scan("import.meta.glob<M>(['/src/lib/ask/*.ts', '/src/lib/sources/*.ts']);")).toEqual(
			[]
		);
		expect(scan("const paths = ['/src/lib/ask/x.ts', '/src/lib/profile/y.ts'];")).toEqual([]);
		expect(scan("import.meta.glob('./*.ts', { eager: true, import: 'default' });")).toEqual([]);
		expect(scan('const m = await import(`./parts/${name}.ts`);')).toEqual([]);
		expect(
			scan(
				[
					'import.meta.glob([',
					"\t// not '/src/lib/profile/*.ts' here",
					"\t'/src/lib/ask/*.ts'",
					'])'
				].join(LF)
			)
		).toEqual([]);
	});

	// The bundler turns a value in the folder of a dynamic import into a glob over every folder there.
	it('flags a dynamic import whose folder is a value', () => {
		expect(scan('const m = await import(`../${folder}/store.svelte.ts`);')).toMatchObject([
			{ token: '../${folder}/store.svelte.ts' }
		]);
	});

	it('reads a long glob list in fair time', () => {
		const items = Array.from({ length: 200 }, (_, i) => `\t'/src/lib/ask/${i}.ts', // note`);
		const started = performance.now();
		expect(scan(['import.meta.glob([', ...items, '])'].join(LF))).toEqual([]);
		expect(scan(`import.meta.glob<${'A<'.repeat(200)}`)).toEqual([]);
		expect(scan("import.meta.glob(['./a/*.ts',".repeat(2000))).toEqual([]);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it('flags an import once, with a comment or without', () => {
		expect(scan("import('#lib/profile/x'); import(/* c */ '#lib/keystore/y');")).toHaveLength(2);
	});

	it('leaves a quote in a comment alone', () => {
		expect(scan(['// pulled in from', "// '#lib/profile/x' by the caller", ''].join(LF))).toEqual(
			[]
		);
		expect(scan(["import( // see '#lib/profile/x'", 'url);'].join(LF))).toEqual([]);
	});

	// The scan runs in the commit hook, so a comment that made it backtrack would stall every commit.
	it('reads a long run of comment lines in fair time', () => {
		const lines = Array.from({ length: 200 }, () => '// see https://a.example/b');
		const started = performance.now();
		expect(scan(['// taken from', ...lines, 'const a = 1;'].join(LF))).toEqual([]);
		expect(scan(`from ${'// '.repeat(200)}`)).toEqual([]);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it('does not read past a comment into another call', () => {
		expect(scan("import(/* @vite-ignore */ url); run('#lib/profile/store.svelte');")).toEqual([]);
		expect(scan("import(/* c */ url); /* later note */ run('#lib/profile/store.svelte');")).toEqual(
			[]
		);
		expect(
			scan(['import(/* c */ url);', '/** Doc. */', "const P = '#lib/profile/x';"].join(LF))
		).toEqual([]);
	});

	it('does not let a quoted word ending in "from" hide the next import', () => {
		expect(
			scan(["const label = 'Imported from';", "import { a } from '#lib/profile/x';"].join('\n'))
		).toHaveLength(1);
		expect(
			scan(
				["// Resend's 'from' address is verified", "import { a } from '#lib/profile/x';"].join('\n')
			)
		).toHaveLength(1);
	});

	it('flags a Vite glob import of a banned folder', () => {
		expect(
			scan("const m = import.meta.glob('/src/lib/profile/*.ts', { eager: true });")
		).toHaveLength(1);
		expect(scan("const m = import.meta.glob(['../../profile/*.ts']);")).toHaveLength(1);
	});

	it('leaves a route named in prose alone', () => {
		expect(scan("// the user came from '/timeline'")).toEqual([]);
	});

	it('leaves public modules and platform modules alone', () => {
		expect(scan(`import type { CorpusChunk } from '#lib/corpus';`)).toEqual([]);
		expect(scan(`import { isGovernmentHost } from '#lib/sources/government-host';`)).toEqual([]);
		expect(scan(`import { webcrypto } from 'node:crypto';`)).toEqual([]);
		expect(scan(`import { createHash } from 'crypto';`)).toEqual([]);
	});

	it('the ban covers the Ask store and leaves out only the home route', () => {
		const scanned = collectImportBanFiles();
		expect(scanned.some((p) => p.endsWith(join('ask', 'store.svelte.ts')))).toBe(true);
		expect(scanned.some((p) => p.endsWith(join('routes', '+page.svelte')))).toBe(false);
	});

	it('the real off-device source imports none of them', () => {
		const files = collectImportBanFiles().map((path) => ({
			path,
			content: readFileSync(path, 'utf8')
		}));
		expect(scanForPiiImports(files)).toEqual([]);
	});
});

/**
 * The import ban's scope: every off-device unit and the Ask store. Only the home route is left out, because it reads
 * the profile context to know first-run status; it keeps the field-name scan.
 */
function collectImportBanFiles(): string[] {
	return [
		...findServerFiles(join(process.cwd(), 'src')),
		...[...ONLINE_PATH_DIRS, ...FEEDBACK_PATH_DIRS].flatMap((dir) =>
			findSourceFiles(join(process.cwd(), dir))
		),
		...['src/lib/ask/store.svelte.ts', ...FEEDBACK_PATH_FILES].map((file) =>
			join(process.cwd(), file)
		)
	];
}

describe('pii-policy: the BYO API key never reaches our own endpoints', () => {
	it('flags the key named in an online unit', () => {
		const violations = scanForPiiTokens(
			[{ path: 'src/lib/ask/online/x.ts', content: "headers: { 'x-api-key': deps.apiKey }" }],
			BYO_KEY_PATTERNS
		);
		expect(violations).not.toEqual([]);
	});

	it.each([
		['const k = await byok.readApiKey();', 'the key read'],
		["request.headers.set('X-API-Key', k);", 'the key header'],
		["const apiKey = '';", 'the key variable']
	])('flags %s on its own (%s)', (content) => {
		expect(
			scanForPiiTokens([{ path: 'src/lib/ask/online/x.ts', content }], BYO_KEY_PATTERNS)
		).toHaveLength(1);
	});

	it('the real retrieve, Worker, feedback and server source names no key', () => {
		// Synthesis is left out on purpose: it sends the key browser-direct to Anthropic, its only destination.
		const units = [
			...findServerFiles(join(process.cwd(), 'src')),
			...['src/lib/ask/online', 'workers/retrieve', ...FEEDBACK_PATH_DIRS].flatMap((dir) =>
				findSourceFiles(join(process.cwd(), dir))
			),
			...FEEDBACK_PATH_FILES.map((file) => join(process.cwd(), file))
		];
		const files = units.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
		expect(scanForPiiTokens(files, BYO_KEY_PATTERNS)).toEqual([]);
	});
});
