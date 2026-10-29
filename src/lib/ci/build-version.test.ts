import { afterEach, describe, expect, it, vi } from 'vitest';

// SvelteKit's build version is the build time unless the config names one. The time changes every hashed file name
// that leads to it, so two builds of the same code measure a few bytes apart and the size budgets drift. CI and the
// gate set MEASURE_BUILD=1 to measure with one fixed version; the live build never sets it, because the service
// worker and the update hand-over only see an update when the version changes.

async function versionName(): Promise<unknown> {
	vi.resetModules();
	const { default: config } = await import('../../../svelte.config.js');
	return config.kit?.version?.name;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('the build version', () => {
	it('is the same fixed number on every measuring build', async () => {
		vi.stubEnv('MEASURE_BUILD', '1');
		const first = await versionName();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(await versionName()).toBe(first);
		// The live check reads the version as a number of milliseconds.
		expect(first).toMatch(/^\d{13}$/);
	});

	it('stays the build time on a live build, so every release reaches installed apps', async () => {
		vi.stubEnv('MEASURE_BUILD', '');
		const before = Date.now();
		const name = await versionName();
		const after = Date.now();
		expect(name).toMatch(/^\d+$/);
		expect(Number(name)).toBeGreaterThanOrEqual(before);
		expect(Number(name)).toBeLessThanOrEqual(after);
	});
});
