import { describe, it, expect } from 'vitest';
import { loadCorpus } from './corpus-load';
import { buildCorpusArtifact } from './corpus-artifact';
import { EMBED_MODEL_ID } from './types';
import { AskError } from './errors';
import type { CorpusChunk } from '$lib/corpus';

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
			'1.0'
		);
		const corpus = await loadCorpus(
			fakeFetch(JSON.stringify(manifest), embeddingsBuffer) as typeof fetch,
			'/corpus/corpus-v1.0.1'
		);
		expect(corpus.chunks.map((c) => c.id)).toEqual(['a', 'b']);
		expect(corpus.modelId).toBe(EMBED_MODEL_ID);
	});

	it('throws AskError(E_ASK_CORPUS) when a fetch fails', async () => {
		const fail = (async () => new Response('x', { status: 500 })) as typeof fetch;
		await expect(loadCorpus(fail, '/corpus/corpus-v1.0.1')).rejects.toBeInstanceOf(AskError);
	});
});
