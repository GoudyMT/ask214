import { describe, it, expect } from 'vitest';
import { sourceFromCard, sourcesFromCorpus } from './sources';
import { toExtractiveAnswer } from './answer/answer-view';
import { selectAnswer } from './answer/select-answer';
import { toResultCards } from '$lib/corpus/cards';
import type { Corpus, CorpusChunk } from '$lib/corpus';

function chunk(over: Partial<CorpusChunk>): CorpusChunk {
	return { id: 'x', text: 't', sourceId: 's', sourceTitle: 'S', tags: [], url: 'u', ...over };
}
function corpusOf(chunks: CorpusChunk[]): Corpus {
	return {
		version: '1.0.2',
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

	it('strips a leading section title the extractor duplicated into the block text (de-stutter)', () => {
		const corpus = corpusOf([
			chunk({
				id: 'p1',
				sourceId: 's',
				text: 'Eligibility You must have served 90 days.',
				section: 'Eligibility'
			})
		]);
		expect(sourcesFromCorpus(corpus).get('s')?.passages).toEqual([
			{ id: 'p1', text: 'You must have served 90 days.', section: 'Eligibility' }
		]);
	});

	it('trims a leading separator left after stripping the section title', () => {
		const corpus = corpusOf([
			chunk({ id: 'p3', sourceId: 's', text: 'Benefits: your options', section: 'Benefits' })
		]);
		expect(sourcesFromCorpus(corpus).get('s')?.passages).toEqual([
			{ id: 'p3', text: 'your options', section: 'Benefits' }
		]);
	});

	it('keeps the block text when it does not start with the section', () => {
		const corpus = corpusOf([
			chunk({ id: 'p2', sourceId: 's', text: 'Some other body.', section: 'Eligibility' })
		]);
		expect(sourcesFromCorpus(corpus).get('s')?.passages).toEqual([
			{ id: 'p2', text: 'Some other body.', section: 'Eligibility' }
		]);
	});

	it('carries the stored anchor so the page view can find the passage in the document', () => {
		const corpus = corpusOf([
			chunk({ id: 'p1', text: 'one', page: 3, anchor: { exact: 'raw one', prefix: 'before' } }),
			chunk({ id: 'p2', text: 'two', page: 4 })
		]);
		expect(sourcesFromCorpus(corpus).get('s')?.passages).toEqual([
			{ id: 'p1', text: 'one', page: 3, anchor: 'raw one' },
			{ id: 'p2', text: 'two', page: 4 }
		]);
	});

	// The page view marks the text the answer block QUOTED, so the reader must reproduce that quote from its
	// own passage. Sized past the answer's word budget and opening with a duplicated heading, so both the
	// truncation and the echo strip are exercised - a short fixture passes whether or not either happens.
	it('reproduces the answer block quote from the reader passage text', () => {
		const sentence = (i: number) =>
			`Sentence ${i} explains one more rule about filing a claim with VA.`;
		const body = Array.from({ length: 16 }, (_, i) => sentence(i)).join(' ');
		const c = chunk({
			id: 'q1',
			text: `Filing a claim ${body}`,
			section: 'Filing a claim',
			page: 2
		});

		const passage = sourcesFromCorpus(corpusOf([c])).get('s')?.passages[0];
		const answer = toExtractiveAnswer(toResultCards([{ chunk: c, score: 1 }]));

		expect(answer?.text.startsWith('Sentence 0')).toBe(true);
		expect(answer?.text.split(' ').length).toBeLessThan(body.split(' ').length);
		expect(selectAnswer(passage?.text ?? '')).toBe(answer?.text);
	});
});

// An online answer carries its passage in the search result itself, so the reader opens on it without the
// answer library. It must show and search exactly what the on-device path would, or the two readers differ.
describe('sourceFromCard', () => {
	// As extracted: a running page header, then the section heading echoed into the body. Display drops
	// both; the document still carries both, so the anchor keeps them.
	const RAW =
		'EFCT PARTICIPANT GUIDE | SECTION 1 | PAGE 10 Vet Center services Counseling is free and confidential for eligible veterans.';
	const hit = chunk({
		id: 'tap_vet_centers:0a1b2c3d4e5f',
		sourceId: 'tap_vet_centers',
		sourceTitle: 'TAP - Vet Centers (Resource Guide)',
		url: 'https://www.tapevents.mil/resources/documents',
		page: 12,
		section: 'Vet Center services',
		text: RAW
	});

	it('builds a one-passage source from the card the user opened', () => {
		const [card] = toResultCards([{ chunk: hit, score: 0.8 }]);
		expect(sourceFromCard(card!)).toEqual({
			sourceId: 'tap_vet_centers',
			title: 'TAP - Vet Centers (Resource Guide)',
			url: 'https://www.tapevents.mil/resources/documents',
			passages: [
				{
					id: 'tap_vet_centers:0a1b2c3d4e5f',
					text: 'Counseling is free and confidential for eligible veterans.',
					page: 12,
					section: 'Vet Center services',
					anchor: RAW
				}
			]
		});
	});

	// Parity with the on-device reader: the same displayed words (so the same quote is tinted) and the same
	// anchor (so the same passage is found in the document).
	// The server's copy of a passage carries no anchor field; the corpus's carries one equal to its text.
	it('shows and searches for exactly what the on-device reader does, for the same passage', () => {
		const [card] = toResultCards([{ chunk: hit, score: 0.8 }]);
		const device = sourcesFromCorpus(corpusOf([{ ...hit, anchor: { exact: RAW } }])).get(
			'tap_vet_centers'
		)?.passages[0];
		const online = sourceFromCard(card!).passages[0];
		expect(device?.anchor).toBe(RAW);
		expect(online?.text).toBe(device?.text);
		expect(online?.anchor).toBe(device?.anchor);
	});

	it('leaves out what the card does not carry, rather than writing undefined', () => {
		const passage = sourceFromCard({
			sourceId: 'va_intent_to_file',
			sourceTitle: 'VA - Intent to File',
			chunkId: 'va_intent_to_file:000000000001',
			excerpt: 'An intent to file sets a potential effective date.',
			url: 'https://www.va.gov/',
			score: 0.7
		}).passages[0];
		expect(passage).toEqual({
			id: 'va_intent_to_file:000000000001',
			text: 'An intent to file sets a potential effective date.'
		});
	});
});
