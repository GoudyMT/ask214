import { afterEach, describe, expect, it, vi } from 'vitest';

// SvelteKit's own config loader: the build calls it once for the server and service worker and again for the
// client, so the version is read here the way a build reads it. Not a public export (no types ship for it); a move
// fails this file loudly.
const KIT_CONFIG_LOADER = '../../../node_modules/@sveltejs/kit/src/core/config/index.js';

type LoadConfig = () => Promise<{ kit: { version: { name: string } } }>;

// The build version reaches every hashed file name that leads to it, so a version that changes between builds
// moves the measured sizes a few bytes. CI and the gate set MEASURE_BUILD=1 to measure with one fixed version. A
// live build must carry ONE version that is new each build: the page asks the service worker to take over by
// sending its version, and the worker obeys only its own.

const PROCESS_START_MS = Date.now() - process.uptime() * 1000;

async function twoBuildReads(): Promise<[string, string]> {
	const { load_config } = (await import(KIT_CONFIG_LOADER)) as { load_config: LoadConfig };
	const first = (await load_config()).kit.version.name;
	await new Promise((resolve) => setTimeout(resolve, 5));
	const second = (await load_config()).kit.version.name;
	return [first, second];
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('the build version', () => {
	it('is one fixed stamp on every measuring build', async () => {
		vi.stubEnv('MEASURE_BUILD', '1');
		const [first, second] = await twoBuildReads();
		expect(second).toBe(first);
		// Fixed, not this build's clock: the next measuring build gets the same stamp.
		expect(Number(first)).toBeLessThan(PROCESS_START_MS);
		// The live check reads the version as a number of milliseconds.
		expect(first).toMatch(/^\d{13}$/);
	});

	it('is one version across a live build, new to that build, so an update can take over', async () => {
		vi.stubEnv('MEASURE_BUILD', '');
		const [first, second] = await twoBuildReads();
		expect(second).toBe(first);
		expect(Number(first)).toBeGreaterThanOrEqual(Math.floor(PROCESS_START_MS) - 1000);
		expect(Number(first)).toBeLessThanOrEqual(Date.now());
	});
});
