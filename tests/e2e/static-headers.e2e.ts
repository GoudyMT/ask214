import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headersFor, parseHeadersFile } from '../../src/lib/ci/headers-policy';

// Cloudflare applies `_headers` to the static files it serves. A worker takes its content security policy from its
// own script's response, so these files carry the only policy the workers get; the preview server must send them as
// production does, or no test here could show a worker policy is missing.
const RULES = parseHeadersFile(readFileSync(join(process.cwd(), '_headers'), 'utf8'));

function onlyFileIn(folder: string, suffix: string): string {
	const names = readdirSync(folder, { recursive: true, encoding: 'utf8' }).filter((name) =>
		name.endsWith(suffix)
	);
	expect(names, `one ${suffix} file in ${folder}`).toHaveLength(1);
	return (names[0] ?? '').replaceAll('\\', '/');
}

const BUILT_WORKERS = join(process.cwd(), '.svelte-kit/output/client/_app/immutable/workers');

// Each path is read when its test runs: the built worker exists only once the preview server's build has run,
// which is after the test files are loaded.
const STATIC_FILES: Record<string, () => string> = {
	'the on-device answer worker': () =>
		`/_app/immutable/workers/${onlyFileIn(BUILT_WORKERS, '.js')}`,
	'the backup key worker': () =>
		`/backup-kdf/${onlyFileIn(join(process.cwd(), 'static/backup-kdf'), '.worker.mjs')}`,
	"the PDF library's worker": () =>
		`/pdf-worker/${onlyFileIn(join(process.cwd(), 'static/pdf-worker'), 'pdf.worker.min.mjs')}`
};

for (const [name, pathOf] of Object.entries(STATIC_FILES)) {
	test(`${name} is served with its content security policy`, async ({ request }) => {
		const path = pathOf();
		const expected = headersFor(RULES, path)['Content-Security-Policy'];
		expect(expected, 'the file names a policy for this folder').toBeTruthy();
		const response = await request.get(path);
		expect(response.status()).toBe(200);
		expect(response.headers()['content-security-policy']).toBe(expected);
	});
}

test('the saved-documents page is never kept by a cache', async ({ request }) => {
	expect((await request.get('/documents')).headers()['cache-control']).toBe('no-store');
});
