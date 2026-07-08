import { describe, it, expect } from 'vitest';
import { decodeCorpus, ACCEPTED_CORPUS_VERSION } from './codec';
import { CorpusFormatError, CorpusVersionError } from './errors';
import type { CorpusManifest } from './types';

const MODEL = 'all-MiniLM-L6-v2';

function manifest(over: Partial<CorpusManifest> = {}): CorpusManifest {
	return {
		version: ACCEPTED_CORPUS_VERSION,
		dim: 2,
		modelId: MODEL,
		chunks: [
			{
				id: 'a',
				text: 'A',
				sourceId: 's',
				sourceTitle: 'S',
				tags: [],
				url: 'https://example.gov/'
			},
			{ id: 'b', text: 'B', sourceId: 's', sourceTitle: 'S', tags: [], url: 'https://example.gov/' }
		],
		...over
	};
}

// A flat Float32 blob of 2 chunks x dim 2 = 4 floats.
function buffer(floats: number[]): ArrayBuffer {
	return new Float32Array(floats).buffer;
}

describe('decodeCorpus', () => {
	it('decodes a valid corpus and pre-normalizes the embeddings to unit vectors', () => {
		const corpus = decodeCorpus(manifest(), buffer([3, 4, 0, 5]), MODEL);
		expect(corpus.chunks.map((c) => c.id)).toEqual(['a', 'b']);
		expect(corpus.embeddings).toHaveLength(2);
		expect(corpus.embeddings[0]![0]).toBeCloseTo(0.6, 6); // 3/5
		expect(corpus.embeddings[0]![1]).toBeCloseTo(0.8, 6); // 4/5
		expect(corpus.embeddings[1]![1]).toBeCloseTo(1, 6); // [0,5] -> [0,1]
	});

	it('throws CorpusVersionError when the corpus version is not accepted', () => {
		expect(() => decodeCorpus(manifest({ version: '999.0' }), buffer([1, 0, 0, 1]), MODEL)).toThrow(
			CorpusVersionError
		);
	});

	it('throws CorpusFormatError when the corpus model id != expected', () => {
		expect(() => decodeCorpus(manifest(), buffer([1, 0, 0, 1]), 'BGE-small')).toThrow(
			CorpusFormatError
		);
	});

	it('throws CorpusFormatError when the embeddings byte length is wrong', () => {
		// 2 chunks x dim 2 needs 4 floats; give 3.
		expect(() => decodeCorpus(manifest(), buffer([1, 0, 0]), MODEL)).toThrow(CorpusFormatError);
	});

	it('throws CorpusFormatError when an embedding has zero magnitude', () => {
		expect(() => decodeCorpus(manifest(), buffer([1, 0, 0, 0]), MODEL)).toThrow(CorpusFormatError);
	});

	it('throws CorpusFormatError when a chunk url is not https (blocks javascript:/data: hrefs)', () => {
		const badUrl = manifest({
			chunks: [
				{
					id: 'a',
					text: 'A',
					sourceId: 's',
					sourceTitle: 'S',
					tags: [],
					url: 'javascript:alert(1)'
				},
				{
					id: 'b',
					text: 'B',
					sourceId: 's',
					sourceTitle: 'S',
					tags: [],
					url: 'https://example.gov/'
				}
			]
		});
		expect(() => decodeCorpus(badUrl, buffer([1, 0, 0, 1]), MODEL)).toThrow(CorpusFormatError);
	});

	it('throws CorpusFormatError when dim is not a positive integer (shape gate before byte-length)', () => {
		// dim 1.5 x 2 chunks = 12 expected bytes; a 3-float (12-byte) blob sneaks past the byte-length gate,
		// so without a shape gate the decoder would slice garbage instead of failing loud.
		expect(() => decodeCorpus(manifest({ dim: 1.5 }), buffer([1, 0, 1]), MODEL)).toThrow(
			CorpusFormatError
		);
	});

	it('preserves an optional anchor on the chunk (additive; passes through decode by reference)', () => {
		const withAnchor = manifest({
			chunks: [
				{
					id: 'a',
					text: 'a verbatim span here',
					sourceId: 's',
					sourceTitle: 'S',
					tags: [],
					url: 'https://example.gov/',
					anchor: { exact: 'verbatim span', prefix: 'a ', suffix: ' here' }
				}
			]
		});
		const corpus = decodeCorpus(withAnchor, buffer([3, 4]), MODEL);
		expect(corpus.chunks[0]!.anchor).toEqual({
			exact: 'verbatim span',
			prefix: 'a ',
			suffix: ' here'
		});
	});

	it('tolerates an added contentRevision manifest field (producer metadata) without surfacing it', () => {
		const withRevision = manifest({
			contentRevision: { buildDate: '2026-07-08', contentHash: 'a'.repeat(64) }
		});
		const corpus = decodeCorpus(withRevision, buffer([3, 4, 0, 5]), MODEL);
		expect(corpus.chunks.map((c) => c.id)).toEqual(['a', 'b']);
		expect('contentRevision' in corpus).toBe(false);
	});
});
