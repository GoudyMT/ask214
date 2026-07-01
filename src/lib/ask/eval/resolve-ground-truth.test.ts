import { describe, it, expect } from 'vitest';
import { resolveExpectedIds, type GroundTruthQuery } from './resolve-ground-truth';
import type { CorpusChunk } from '$lib/corpus';

const chunk = (id: string, sourceId: string, text: string): CorpusChunk => ({
	id,
	text,
	sourceId,
	sourceTitle: 't',
	url: 'https://x.gov',
	tags: []
});

const bySource = new Map<string, CorpusChunk[]>([
	[
		'va_x',
		[
			chunk('va_x:1', 'va_x', 'How to file a claim. Gather your evidence first.'),
			chunk('va_x:2', 'va_x', 'You can apply online or by mail today.')
		]
	],
	['va_y', [chunk('va_y:1', 'va_y', 'Unrelated content about home loans.')]]
]);

const gt = (sourceId: string, answerSnippet: string): GroundTruthQuery => ({
	query: 'q',
	sourceId,
	answerSnippet
});

describe('resolveExpectedIds', () => {
	it('resolves a snippet to the one chunk that contains it', () => {
		expect(resolveExpectedIds(gt('va_x', 'Gather your evidence first'), bySource)).toEqual([
			'va_x:1'
		]);
	});

	it('only searches the given source', () => {
		expect(resolveExpectedIds(gt('va_x', 'home loans'), bySource)).toEqual([]);
	});

	it('returns [] when no chunk contains the snippet (a build signal to fix the snippet)', () => {
		expect(resolveExpectedIds(gt('va_x', 'benefits for spouses'), bySource)).toEqual([]);
	});

	it('collapses whitespace runs (normalizeText) so spacing variance still matches', () => {
		expect(resolveExpectedIds(gt('va_x', 'apply   online   or   by   mail'), bySource)).toEqual([
			'va_x:2'
		]);
	});

	it('folds curly quotes to straight so an author-typed straight quote matches curly source text', () => {
		const apostrophe = String.fromCharCode(0x2019);
		const curly = new Map<string, CorpusChunk[]>([
			['s', [chunk('s:1', 's', `Find out if you${apostrophe}re eligible for compensation.`)]]
		]);
		expect(resolveExpectedIds(gt('s', "if you're eligible"), curly)).toEqual(['s:1']);
	});

	it('returns every chunk that contains the snippet (all count as relevant)', () => {
		const dup = new Map<string, CorpusChunk[]>([
			['d', [chunk('d:1', 'd', 'apply today'), chunk('d:2', 'd', 'you can apply today')]]
		]);
		expect(resolveExpectedIds(gt('d', 'apply today'), dup)).toEqual(['d:1', 'd:2']);
	});
});
