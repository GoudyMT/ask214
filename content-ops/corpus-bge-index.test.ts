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

// Read a top-level `const NAME = ...;` literal straight from a source file, so the assertions below bind
// to the values the code actually ships, not a copy transcribed into this test.
function constLine(src: string, name: string): string {
	// Locate the declaration line by a plain string search (the name is interpolated into a STRING, not
	// a regex - no dynamic RegExp), then extract the literal with a LITERAL regex in the callers below.
	const line = src.split('\n').find((l) => l.includes(`const ${name} = `));
	if (line === undefined) throw new Error('required const not found in source');
	return line;
}
function numConst(src: string, name: string): number {
	const m = /= ([\d.]+);/.exec(constLine(src, name));
	const v = m?.[1];
	if (v === undefined) throw new Error('required numeric const not found in source');
	return Number(v);
}
function strConst(src: string, name: string): string {
	const m = /= '([^']*)';/.exec(constLine(src, name));
	const v = m?.[1];
	if (v === undefined) throw new Error('required string const not found in source');
	return v;
}

// ADR-025 config-as-invariant: bge is asymmetric (the query carries the instruction prefix; passages do
// not), and MIN_SCORE is a held-out-calibrated cutoff. The retrieve Worker, the bge eval, and the built
// index must agree on the model id, the query prefix, and the cutoff, or the online path silently drops
// or admits the wrong results. The Worker states this invariant in a comment; this fails the build when
// any of the three drifts, so it can never go unenforced. On failure: re-run `pnpm eval:bge`, reconcile.
describe('retrieve Worker config is bound to the index it serves (ADR-025)', () => {
	const bge = loadManifest(BGE_MANIFEST);
	const worker = readFileSync('workers/retrieve/src/index.ts', 'utf8');
	const bgeEval = readFileSync('content-ops/eval-corpus-bge.mjs', 'utf8');

	it('Worker query + embed model ids match the model the index was built with', () => {
		expect(strConst(worker, 'BGE_MODEL_ID')).toBe(bge.modelId);
		expect(strConst(worker, 'EMBED_MODEL')).toBe(bge.modelId);
	});

	it('Worker MIN_SCORE matches the held-out-calibrated cutoff the eval gates on', () => {
		expect(numConst(worker, 'MIN_SCORE')).toBe(numConst(bgeEval, 'WORKER_MIN_SCORE'));
	});

	it('Worker QUERY_PREFIX matches the prefix the index was evaluated with', () => {
		expect(strConst(worker, 'QUERY_PREFIX')).toBe(strConst(bgeEval, 'QUERY_PREFIX'));
	});
});
