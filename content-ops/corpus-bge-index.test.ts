import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeCorpus } from '$lib/corpus';
import type { CorpusManifest } from '$lib/corpus/types';

// The retrieve Worker decodes the KV index under this exact model id (workers/retrieve/src/index.ts).
const BGE_MODEL_ID = '@cf/baai/bge-small-en-v1.5';
const BGE_MANIFEST = 'content-ops/server-index/corpus-v1.0.bge.json';
const BGE_EMBEDDINGS = 'content-ops/server-index/corpus-v1.0.bge.bin';
const MINILM_MANIFEST = 'static/corpus/corpus-v1.0.1.json';

function loadManifest(path: string): CorpusManifest {
	return JSON.parse(readFileSync(path, 'utf8')) as CorpusManifest;
}
function loadArrayBuffer(path: string): ArrayBuffer {
	const buf = readFileSync(path);
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('bge server corpus index', () => {
	const bge = loadManifest(BGE_MANIFEST);
	const minilm = loadManifest(MINILM_MANIFEST);

	it('decodes under the retrieve Worker model id', () => {
		const corpus = decodeCorpus(bge, loadArrayBuffer(BGE_EMBEDDINGS), BGE_MODEL_ID);
		expect(corpus.modelId).toBe(BGE_MODEL_ID);
		expect(corpus.embeddings.length).toBe(bge.chunks.length);
	});

	it('is 384-dimensional (bge-small-en-v1.5)', () => {
		expect(bge.dim).toBe(384);
	});

	it('carries the same chunk set + version as the MiniLM index (one build, both indexes)', () => {
		expect(bge.chunks.length).toBe(minilm.chunks.length);
		expect(bge.version).toBe(minilm.version);
	});
});
