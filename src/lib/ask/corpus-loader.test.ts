import { describe, it, expect, vi } from 'vitest';
import { createLazyCorpus } from './corpus-loader';
import type { Corpus } from '$lib/corpus';

function fixtureCorpus(): Corpus {
	return { version: '1.0', dim: 1, modelId: 'm', chunks: [], embeddings: [] };
}

describe('createLazyCorpus', () => {
	it('does not load until first called', () => {
		const load = vi.fn(async () => fixtureCorpus());
		createLazyCorpus(load, () => {});
		expect(load).not.toHaveBeenCalled();
	});

	it('loads once and memoizes across calls', async () => {
		const load = vi.fn(async () => fixtureCorpus());
		const get = createLazyCorpus(load, () => {});
		const [a, b] = await Promise.all([get(), get()]);
		expect(load).toHaveBeenCalledTimes(1);
		expect(a).toBe(b);
	});

	it('calls onLoaded with the corpus on success', async () => {
		const corpus = fixtureCorpus();
		const onLoaded = vi.fn();
		const get = createLazyCorpus(async () => corpus, onLoaded);
		await get();
		expect(onLoaded).toHaveBeenCalledWith(corpus);
	});

	it('does NOT cache a rejection when onLoaded throws: a later call retries', async () => {
		const load = vi.fn(async () => fixtureCorpus());
		let calls = 0;
		const onLoaded = () => {
			calls++;
			if (calls === 1) throw new Error('onLoaded boom');
		};
		const get = createLazyCorpus(load, onLoaded);
		await expect(get()).rejects.toThrow('onLoaded boom'); // first call: onLoaded throws
		await get(); // retry re-invokes load and succeeds
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('does NOT cache a rejection: a later call retries the load', async () => {
		let attempt = 0;
		const load = vi.fn(async () => {
			attempt++;
			if (attempt === 1) throw new Error('transient');
			return fixtureCorpus();
		});
		const get = createLazyCorpus(load, () => {});
		await expect(get()).rejects.toThrow('transient'); // first call rejects
		const corpus = await get(); // retry re-invokes load and succeeds
		expect(load).toHaveBeenCalledTimes(2);
		expect(corpus.version).toBe('1.0');
	});
});
