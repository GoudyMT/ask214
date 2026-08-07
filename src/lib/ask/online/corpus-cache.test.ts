import { describe, it, expect } from 'vitest';
import { createCachedLoader } from './corpus-cache';

describe('createCachedLoader', () => {
	it('shares a single in-flight load across concurrent callers', async () => {
		let calls = 0;
		const load = createCachedLoader(async () => {
			calls++;
			return 'v';
		});
		const [a, b] = await Promise.all([load(), load()]);
		expect(a).toBe('v');
		expect(b).toBe('v');
		expect(calls).toBe(1); // one load served both callers
	});

	it('reuses a resolved value for later calls without re-loading', async () => {
		let calls = 0;
		const load = createCachedLoader(async () => {
			calls++;
			return calls;
		});
		expect(await load()).toBe(1);
		expect(await load()).toBe(1); // the cached value, not a second load
		expect(calls).toBe(1);
	});

	it('clears the memo on rejection so the next call retries (no poisoned isolate)', async () => {
		let calls = 0;
		const load = createCachedLoader(async () => {
			calls++;
			if (calls === 1) throw new Error('transient');
			return 'recovered';
		});
		await expect(load()).rejects.toThrow('transient'); // the first load fails
		expect(await load()).toBe('recovered'); // the retry re-runs the loader and succeeds
		expect(calls).toBe(2);
	});
});
