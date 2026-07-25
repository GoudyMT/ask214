import { describe, it, expect } from 'vitest';
import { computeChainState } from './chain-state';
import type { ChainStateInput } from './chain-state';

// A source whose extraction matches the registry, cleaned+approved, chunked -> every per-source stage skips.
function currentSource(): ChainStateInput['sources'][number] {
	return {
		sourceId: 'tap_va_benefits_guide',
		extractedContentHash: 'aaaa',
		cleanedFromContentHash: 'aaaa',
		cleanedDecision: 'approved',
		chunksPresent: true
	};
}

describe('computeChainState', () => {
	it('skips every stage when all outputs are current (approved + embedded)', () => {
		const state = computeChainState({
			sources: [currentSource()],
			chunksContentHash: 'ZZZ',
			corpusContentHash: 'ZZZ'
		});
		expect(state.sources[0]).toEqual({
			sourceId: 'tap_va_benefits_guide',
			ingest: 'skip',
			clean: 'skip',
			chunk: 'skip'
		});
		expect(state.embed).toBe('skip');
		expect(state.reviewGatePending).toEqual([]);
	});

	it('skips ingest whenever the extraction exists on disk (corpus rebuilds from extractions; refresh detects network change)', () => {
		const s = { ...currentSource(), extractedContentHash: 'ANY', cleanedFromContentHash: 'OLD' };
		const state = computeChainState({
			sources: [s],
			chunksContentHash: 'Z',
			corpusContentHash: 'Z'
		});
		expect(state.sources[0]?.ingest).toBe('skip');
	});

	it('runs ingest only when no extraction exists yet', () => {
		const s = { ...currentSource(), extractedContentHash: null };
		const state = computeChainState({
			sources: [s],
			chunksContentHash: 'Z',
			corpusContentHash: 'Z'
		});
		expect(state.sources[0]?.ingest).toBe('run');
	});

	it('runs clean when the cleaned output was built from a different extraction', () => {
		const s = { ...currentSource(), cleanedFromContentHash: 'OLD' };
		const state = computeChainState({
			sources: [s],
			chunksContentHash: 'Z',
			corpusContentHash: 'Z'
		});
		expect(state.sources[0]?.clean).toBe('run');
	});

	it('reports the review gate (not a plain run) when a current cleaned output is pending approval', () => {
		const s = { ...currentSource(), cleanedDecision: 'pending' as const };
		const state = computeChainState({
			sources: [s],
			chunksContentHash: 'Z',
			corpusContentHash: 'Z'
		});
		expect(state.sources[0]?.clean).toBe('gate-pending');
		expect(state.reviewGatePending).toEqual(['tap_va_benefits_guide']);
	});

	it('runs chunk when clean is not skipped, or when chunks are absent', () => {
		const cleanRuns = computeChainState({
			sources: [{ ...currentSource(), cleanedFromContentHash: 'OLD' }],
			chunksContentHash: 'Z',
			corpusContentHash: 'Z'
		});
		expect(cleanRuns.sources[0]?.chunk).toBe('run');
		const noChunks = computeChainState({
			sources: [{ ...currentSource(), chunksPresent: false }],
			chunksContentHash: 'Z',
			corpusContentHash: 'Z'
		});
		expect(noChunks.sources[0]?.chunk).toBe('run');
	});

	it('runs embed when the chunks content hash differs from the committed corpus (and when no corpus exists)', () => {
		const changed = computeChainState({
			sources: [currentSource()],
			chunksContentHash: 'NEW',
			corpusContentHash: 'OLD'
		});
		expect(changed.embed).toBe('run');
		const noCorpus = computeChainState({
			sources: [currentSource()],
			chunksContentHash: 'NEW',
			corpusContentHash: null
		});
		expect(noCorpus.embed).toBe('run');
	});
});
