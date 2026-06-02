import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanForPiiTokens } from './pii-policy';

// Server-side SvelteKit source: anything that can execute on a server. v1.0 ships
// none of these; the guard protects Phase 3+ backend work (ADR-004: PII stays on device).
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
