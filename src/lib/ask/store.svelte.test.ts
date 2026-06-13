import { describe, it, expect } from 'vitest';
import { createAskStore } from './store.svelte';
import { AskError, ASK_ERROR } from './errors';
import type { Corpus, CorpusChunk } from '$lib/corpus';

function chunk(id: string): CorpusChunk {
	return { id, text: id, sourceId: 's', sourceTitle: 'S', tags: [], url: 'https://example.gov' };
}
function fixtureCorpus(): Corpus {
	return {
		version: '1.0',
		dim: 3,
		modelId: 'all-MiniLM-L6-v2',
		chunks: [chunk('a'), chunk('b')],
		embeddings: [new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0])]
	};
}

describe('createAskStore', () => {
	it('starts idle', () => {
		const store = createAskStore({
			embed: async () => new Float32Array([1, 0, 0]),
			corpus: fixtureCorpus()
		});
		expect(store.state.kind).toBe('idle');
	});

	it('shows modelLoading on the first query, then results', async () => {
		let release: (v: Float32Array) => void = () => {};
		const embed = () => new Promise<Float32Array>((r) => (release = r));
		const store = createAskStore({ embed, corpus: fixtureCorpus() });
		const p = store.ask('how do I file a claim');
		expect(store.state.kind).toBe('modelLoading'); // synchronous, before embed resolves
		release(new Float32Array([1, 0, 0]));
		await p;
		expect(store.state.kind).toBe('results');
		if (store.state.kind === 'results') {
			expect(store.state.cards.length).toBeGreaterThan(0);
			expect(store.state.cards[0]!.sourceTitle).toBe('S');
		}
	});

	it('shows embedding (not modelLoading) once the model is loaded', async () => {
		let release: (v: Float32Array) => void = () => {};
		const embed = () => new Promise<Float32Array>((r) => (release = r));
		const store = createAskStore({ embed, corpus: fixtureCorpus() });
		const first = store.ask('first');
		release(new Float32Array([1, 0, 0]));
		await first;
		void store.ask('second'); // sets state synchronously before its embed resolves
		expect(store.state.kind).toBe('embedding');
	});

	it('surfaces error when an online embed fails', async () => {
		const store = createAskStore({
			embed: async () => {
				throw new AskError(ASK_ERROR.EMBED);
			},
			corpus: fixtureCorpus()
		});
		await store.ask('q');
		expect(store.state.kind).toBe('error');
		if (store.state.kind === 'error') expect(store.state.code).toBe(ASK_ERROR.EMBED);
	});

	it('surfaces offline when a first-run embed fails with no network', async () => {
		const original = navigator.onLine;
		Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
		try {
			const store = createAskStore({
				embed: async () => {
					throw new AskError(ASK_ERROR.EMBED);
				},
				corpus: fixtureCorpus()
			});
			await store.ask('q');
			expect(store.state.kind).toBe('offline');
		} finally {
			Object.defineProperty(navigator, 'onLine', { value: original, configurable: true });
		}
	});
});
