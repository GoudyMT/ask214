import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	FORBIDDEN_PII_PATTERNS,
	PII_FIELD_NAMES,
	scanForPiiImports,
	scanForPiiTokens
} from './pii-policy';

// Server-side SvelteKit source: anything that can execute on a server. The feedback
// endpoint is the one today; the guard covers it and any added later (PII stays on device).
const SERVER_FILE_PATTERN =
	/(\+server\.[jt]s|\+page\.server\.[jt]s|\+layout\.server\.[jt]s|hooks\.server\.[jt]s)$/;

/** Recursively collect server-side source files under a directory. */
function findServerFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...findServerFiles(full));
		} else if (SERVER_FILE_PATTERN.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

describe('pii-policy: server source must not reference ProfileV1 PII fields', () => {
	it('flags a planted PII token in a server file', () => {
		const violations = scanForPiiTokens([
			{ path: 'src/routes/x/+server.ts', content: 'const v = profile.eaos;' }
		]);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.token).toBe('\\.eaos\\b');
	});

	it.each(['skillbridgeStart', 'terminalLeaveStart'])('flags the leaving date %s', (field) => {
		const violations = scanForPiiTokens([
			{ path: 'src/routes/x/+server.ts', content: `const v = persona.leaving.${field};` }
		]);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.token).toBe(`\\.${field}\\b`);
	});

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

/** Recursively collect non-test, non-generated .ts source files under a directory. */
function findSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...findSourceFiles(full));
		} else if (
			entry.name.endsWith('.ts') &&
			!entry.name.endsWith('.test.ts') &&
			!entry.name.endsWith('.d.ts')
		) {
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

	it.each(PII_FIELD_NAMES)('flags %s destructured over several lines', (field) => {
		expect(scan(['const {', '\ta,', `\t${field}`, '} = profile;'].join('\n'))).not.toEqual([]);
	});

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
	});
});

describe('pii-policy: off-device code must not import the personal-data modules', () => {
	const scan = (content: string) =>
		scanForPiiImports([{ path: 'src/lib/ask/online/x.ts', content }]);

	it.each([
		'$lib/profile/store.svelte',
		'../../profile/codec',
		'$lib/keystore/record',
		'$lib/timeline/state.svelte',
		'$lib/calendar/store.svelte',
		'$lib/db/schema',
		'$lib/crypto/aes-gcm',
		'../../../src/lib/profile/types'
	])('flags an import of %s', (specifier) => {
		const violations = scan(`import { a } from '${specifier}';`);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.token).toBe(specifier);
	});

	it('flags a dynamic import, a side-effect import and an import split over several lines', () => {
		expect(scan(`const m = await import('$lib/profile/store.svelte');`)).toHaveLength(1);
		expect(scan(`import '$lib/keystore/record';`)).toHaveLength(1);
		expect(
			scan(['import {', '\ta,', '\tb', "} from '$lib/profile/codec';"].join('\n'))
		).toHaveLength(1);
	});

	it('leaves public modules and platform modules alone', () => {
		expect(scan(`import type { CorpusChunk } from '$lib/corpus';`)).toEqual([]);
		expect(scan(`import { isGovernmentHost } from '$lib/sources/government-host';`)).toEqual([]);
		expect(scan(`import { webcrypto } from 'node:crypto';`)).toEqual([]);
		expect(scan(`import { createHash } from 'crypto';`)).toEqual([]);
	});

	it('the real off-device source imports none of them', () => {
		// The Ask store and the home route are left out on purpose: the home route reads the profile context to know
		// first-run status. Both keep the field-name scan above.
		const units = [
			...findServerFiles(join(process.cwd(), 'src')),
			...[...ONLINE_PATH_DIRS, ...FEEDBACK_PATH_DIRS].flatMap((dir) =>
				findSourceFiles(join(process.cwd(), dir))
			),
			...FEEDBACK_PATH_FILES.map((file) => join(process.cwd(), file))
		];
		const files = units.map((path) => ({ path, content: readFileSync(path, 'utf8') }));
		expect(scanForPiiImports(files)).toEqual([]);
	});
});
