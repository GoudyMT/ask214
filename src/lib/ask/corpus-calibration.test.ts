import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// MIN_SCORE (src/lib/ask/store.svelte.ts = 0.4) was calibrated against this exact SHIPPED corpus size.
// The cosine-score distribution compresses as the corpus grows, so a size change can erode the margin
// between the weakest valid lead and MIN_SCORE and start silently dropping real answers. The eval re-gate
// (content-ops/run-eval.mjs) that re-confirms the margin is manual-only and not
// wired into CI, so this tripwire fails the build on ANY corpus-size change: when it fails, re-run the
// eval, re-confirm the margin holds (or recalibrate MIN_SCORE), THEN bump CALIBRATED_CHUNK_COUNT.
// Re-confirmed 2026-07-25 at the real 1878-chunk cleaned corpus (the residual-cleanup pass: fused nav-index
// + appendix-ToC removal): MIN_SCORE 0.4 holds the held-out floor (srcHitRate 0.875 / srcMRR 0.618) - and
// run-eval gates the held-out floor at this shipped 0.4 DIRECTLY (not only at the tune-selected cutoff), so a
// `pnpm eval` PASS certifies 0.4 on this corpus. The auto-calibration selects 0.4 on its own (the TUNE split
// holds the floor at every cutoff, srcMRR 0.614). Removing the boilerplate held the source-hit floor flat;
// its value is chunk cleanliness for synthesis + highlighting, not the source-level ranking metric.
const CALIBRATED_CHUNK_COUNT = 1878;

const corpusPath = fileURLToPath(
	new URL('../../../static/corpus/corpus-v1.0.1.json', import.meta.url)
);

describe('corpus calibration tripwire', () => {
	it('shipped corpus size still matches the size MIN_SCORE was calibrated against', () => {
		const manifest = JSON.parse(readFileSync(corpusPath, 'utf8')) as { chunks: unknown[] };
		expect(manifest.chunks.length).toBe(CALIBRATED_CHUNK_COUNT);
	});
});
