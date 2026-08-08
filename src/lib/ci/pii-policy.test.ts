import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanForPiiTokens } from './pii-policy';

// Server-side SvelteKit source: anything that can execute on a server. v1.0 ships
// none of these; the guard protects Phase 3+ backend work (PII stays on device).
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
		...ONLINE_PATH_DIRS.flatMap((dir) => findSourceFiles(join(process.cwd(), dir))),
		...ONLINE_PATH_FILES.map((file) => join(process.cwd(), file))
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

	it('the real online-path source contains no PII tokens', () => {
		const files = collectOnlinePathFiles().map((path) => ({
			path,
			content: readFileSync(path, 'utf8')
		}));
		expect(scanForPiiTokens(files)).toEqual([]);
	});
});
