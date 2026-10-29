import { afterEach, describe, expect, it, vi } from 'vitest';

// SvelteKit's own config loader: it resolves the Vite config and reads the options the sveltekit() plugin settled
// on, so the version is read here the way a build reads it, once per resolve. Not a public export (no types ship
// for it); a move fails this file loudly.
const KIT_CONFIG_LOADER = '../../../node_modules/@sveltejs/kit/src/core/config/index.js';

type KitConfigLoader = {
	load_vite_config: () => Promise<unknown>;
	extract_svelte_config: (viteConfig: unknown) => { version: { name: string } };
};

// The build version reaches every hashed file name that leads to it, so a version that changes between builds
// moves the measured sizes a few bytes. CI and the gate set MEASURE_BUILD=1 to measure with one fixed version. A
// live build must carry ONE version that is new each build: the page asks the service worker to take over by
// sending its version, and the worker obeys only its own.

const PROCESS_START_MS = Date.now() - process.uptime() * 1000;

async function twoBuildReads(): Promise<[string, string]> {
	const { load_vite_config, extract_svelte_config } = (await import(
		KIT_CONFIG_LOADER
	)) as KitConfigLoader;
	const read = async () => extract_svelte_config(await load_vite_config()).version.name;
	const first = await read();
	await new Promise((resolve) => setTimeout(resolve, 5));
	const second = await read();
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
	});

	it('is one version across a live build, new to that build, so an update can take over', async () => {
		vi.stubEnv('MEASURE_BUILD', '');
		const [first, second] = await twoBuildReads();
		expect(second).toBe(first);
		expect(Number(first)).toBeGreaterThanOrEqual(Math.floor(PROCESS_START_MS) - 1000);
		expect(Number(first)).toBeLessThanOrEqual(Date.now());
	});
});
