import { describe, it, expect } from 'vitest';
import { sourcesFromCorpus } from './sources';
import type { Corpus, CorpusChunk } from '$lib/corpus';

function chunk(over: Partial<CorpusChunk>): CorpusChunk {
	return { id: 'x', text: 't', sourceId: 's', sourceTitle: 'S', tags: [], url: 'u', ...over };
}
function corpusOf(chunks: CorpusChunk[]): Corpus {
	return {
		version: '1.0',
		dim: 3,
		modelId: 'all-MiniLM-L6-v2',
		chunks,
		embeddings: chunks.map(() => new Float32Array([1, 0, 0]))
	};
}

describe('sourcesFromCorpus', () => {
	it('groups chunks by source, collecting the title, url, and all of its passages in order', () => {
		const corpus = corpusOf([
			chunk({
				id: 'a',
				sourceId: 'va_itf',
				sourceTitle: 'VA - Intent to File',
				url: 'https://va.gov/itf',
				text: 'passage A'
			}),
			chunk({
				id: 'b',
				sourceId: 'va_itf',
				sourceTitle: 'VA - Intent to File',
				url: 'https://va.gov/itf',
				text: 'passage B'
			}),
			chunk({
				id: 'c',
				sourceId: 'dod_sb',
				sourceTitle: 'DoD SkillBridge',
				url: 'https://skillbridge.mil',
				text: 'passage C'
			})
		]);

		const sources = sourcesFromCorpus(corpus);

		expect(sources.size).toBe(2);
		const itf = sources.get('va_itf');
		expect(itf?.title).toBe('VA - Intent to File');
		expect(itf?.url).toBe('https://va.gov/itf');
		expect(itf?.passages).toEqual([
			{ id: 'a', text: 'passage A' },
			{ id: 'b', text: 'passage B' }
		]);
		expect(sources.get('dod_sb')?.passages).toEqual([{ id: 'c', text: 'passage C' }]);
	});

	it('returns an empty map for an empty corpus', () => {
		expect(sourcesFromCorpus(corpusOf([])).size).toBe(0);
	});

	it('cleans display artifacts (inline bullet glyphs) from each passage the reader shows', () => {
		const SQUARE = String.fromCodePoint(0x25a0); // black square list bullet, as extracted
		const corpus = corpusOf([
			chunk({ text: 'VA Resources ' + SQUARE + ' myVA ' + SQUARE + ' CWV' })
		]);
		expect(sourcesFromCorpus(corpus).get('s')?.passages).toEqual([
			{ id: 'x', text: 'VA Resources - myVA - CWV' }
		]);
	});

	it('carries each passage id and its page/section for the reader (dividers + highlight match)', () => {
		const corpus = corpusOf([
			chunk({ id: 'p1', sourceId: 's', text: 'one', page: 3, section: 'Intro' }),
			chunk({ id: 'p2', sourceId: 's', text: 'two', page: 4 })
		]);
		expect(sourcesFromCorpus(corpus).get('s')?.passages).toEqual([
			{ id: 'p1', text: 'one', page: 3, section: 'Intro' },
			{ id: 'p2', text: 'two', page: 4 }
		]);
	});
});
