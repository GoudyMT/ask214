import { describe, it, expect } from 'vitest';
import { loadCorpus } from './corpus-load';
import { buildCorpusArtifact } from './corpus-artifact';
import { EMBED_MODEL_ID } from './types';
import { AskError } from './errors';
import { ACCEPTED_CORPUS_VERSION, type CorpusChunk } from '#lib/corpus/index.js';

function chunk(id: string): CorpusChunk {
	return { id, text: id, sourceId: 's', sourceTitle: 'S', tags: [], url: 'https://example.gov/' };
}
// A fake fetch that serves the artifact from memory at the two expected paths.
function fakeFetch(manifestJson: string, bin: ArrayBuffer) {
	return async (url: string) => {
		if (url.endsWith('.json')) return new Response(manifestJson, { status: 200 });
		if (url.endsWith('.bin')) return new Response(bin, { status: 200 });
		return new Response('not found', { status: 404 });
	};
}

describe('loadCorpus', () => {
	it('fetches the bundled artifact and decodes it via B', async () => {
		const { manifest, embeddingsBuffer } = buildCorpusArtifact(
			[chunk('a'), chunk('b')],
			[new Float32Array([1, 0]), new Float32Array([0, 1])],
			EMBED_MODEL_ID,
			// Derived, not a literal: this fixture only has to decode, so pinning a version here just makes
			// the test drift the next time a corpus generation ships.
			ACCEPTED_CORPUS_VERSION
		);
		const corpus = await loadCorpus(
			fakeFetch(JSON.stringify(manifest), embeddingsBuffer) as typeof fetch,
			'/corpus/corpus-v1.0.2'
		);
		expect(corpus.chunks.map((c) => c.id)).toEqual(['a', 'b']);
		expect(corpus.modelId).toBe(EMBED_MODEL_ID);
	});

	it('gives up with AskError(E_ASK_CORPUS) when the library goes silent part-way, and stops the download', async () => {
		let embeddings: AbortSignal | undefined;
		const silent = (async (url: string, init?: RequestInit) => {
			// The manifest arrives; the embeddings send their first bytes and then nothing more.
			if (url.endsWith('.json')) return new Response('{}', { status: 200 });
			embeddings = init?.signal ?? undefined;
			const body = new ReadableStream<Uint8Array>({
				start: (c) => c.enqueue(new Uint8Array(8))
			});
			return new Response(body, { status: 200 });
		}) as typeof fetch;
		await expect(loadCorpus(silent, '/corpus/corpus-v1.0.2', 40)).rejects.toBeInstanceOf(AskError);
		expect(embeddings?.aborted).toBe(true);
	});

	// The library's other file is let go at once, so its download does not hold a connection open for nothing.
	it('lets go of the other file when one of the two is refused', async () => {
		let cancelled = false;
		const oneRefused = (async (url: string) => {
			if (url.endsWith('.json')) return new Response('x', { status: 500 });
			const body = new ReadableStream<Uint8Array>({ cancel: () => void (cancelled = true) });
			return new Response(body, { status: 200 });
		}) as typeof fetch;
		await expect(loadCorpus(oneRefused, '/corpus/corpus-v1.0.2', 40)).rejects.toBeInstanceOf(
			AskError
		);
		expect(cancelled).toBe(true);
	});

	it('throws AskError(E_ASK_CORPUS) when a fetch fails', async () => {
		const fail = (async () => new Response('x', { status: 500 })) as typeof fetch;
		await expect(loadCorpus(fail, '/corpus/corpus-v1.0.2')).rejects.toBeInstanceOf(AskError);
	});
});
