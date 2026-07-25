/** A per-stage decision: run it, skip it (output already current), or halt for a human gate. */
export type StageDecision = 'run' | 'skip' | 'gate-pending';

/** The on-disk fingerprints for one source, read by the orchestrator IO layer. */
export type SourceFingerprint = {
	sourceId: string;
	/** extracted/<id>.json content_hash, or null if no extraction on disk. */
	extractedContentHash: string | null;
	/** clean manifest entry's contentHash (the extraction the cleaned output was built from), or null. */
	cleanedFromContentHash: string | null;
	/** clean manifest entry's decision, or null if the source has no cleaned entry yet. */
	cleanedDecision: 'approved' | 'pending' | null;
	/** whether chunks/<id>.json exists. */
	chunksPresent: boolean;
};

export type ChainStateInput = {
	sources: SourceFingerprint[];
	/** computeContentRevision() over the CURRENT per-source chunk files. */
	chunksContentHash: string;
	/** the committed corpus's contentRevision.contentHash, or null if no corpus is on disk. */
	corpusContentHash: string | null;
};

export type SourceStages = {
	sourceId: string;
	ingest: StageDecision;
	clean: StageDecision;
	chunk: StageDecision;
};

export type ChainState = {
	sources: SourceStages[];
	embed: StageDecision;
	/** sourceIds whose clean output is current but not yet approved -- the review gate. */
	reviewGatePending: string[];
};

/**
 * Decides which stages are stale (run), current (skip), or waiting on a human gate (gate-pending),
 * from the on-disk fingerprints. Pure: the orchestrator reads disk and passes fingerprints in.
 *
 * Skip rules (the costly stages only, per the locked design):
 *   - ingest: skip when the extraction exists on disk; run only when it is missing. corpus rebuilds
 *     from the existing extractions and never re-fetches to check for updates (that is refresh's job),
 *     so a present extraction is never re-ingested. This is the network saver.
 *   - clean: run when the cleaned output was built from a different (or missing) extraction; else
 *     gate-pending when a current cleaned output is still pending approval; else skip.
 *   - chunk: cheap + deterministic -- run whenever clean is not a plain skip, or chunks are absent.
 *   - embed: skip when the current chunks' content hash equals the committed corpus's; else run.
 *     This is the CPU saver (a full re-embed is ~1 min).
 * eval is always run by the orchestrator (the floor gate) and is not modeled as skippable.
 */
export function computeChainState(input: ChainStateInput): ChainState {
	const reviewGatePending: string[] = [];
	const sources = input.sources.map((s): SourceStages => {
		const ingest: StageDecision = s.extractedContentHash !== null ? 'skip' : 'run';

		let clean: StageDecision;
		if (s.cleanedFromContentHash === null || s.cleanedFromContentHash !== s.extractedContentHash) {
			clean = 'run';
		} else if (s.cleanedDecision === 'pending') {
			clean = 'gate-pending';
		} else {
			clean = 'skip';
		}
		if (clean === 'gate-pending') reviewGatePending.push(s.sourceId);

		const chunk: StageDecision = clean === 'skip' && s.chunksPresent ? 'skip' : 'run';

		return { sourceId: s.sourceId, ingest, clean, chunk };
	});

	const embed: StageDecision =
		input.corpusContentHash !== null && input.chunksContentHash === input.corpusContentHash
			? 'skip'
			: 'run';

	return { sources, embed, reviewGatePending };
}
