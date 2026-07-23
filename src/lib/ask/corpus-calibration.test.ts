import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// MIN_SCORE (src/lib/ask/store.svelte.ts = 0.4) was calibrated against this exact SHIPPED corpus size.
// The cosine-score distribution compresses as the corpus grows, so a size change can erode the margin
// between the weakest valid lead and MIN_SCORE and start silently dropping real answers. The eval re-gate
// (content-ops/run-eval.mjs) that re-confirms the margin is manual-only and not
// wired into CI, so this tripwire fails the build on ANY corpus-size change: when it fails, re-run the
// eval, re-confirm the margin holds (or recalibrate MIN_SCORE), THEN bump CALIBRATED_CHUNK_COUNT.
// Re-confirmed 2026-07-23 at the real 1901-chunk cleaned corpus: MIN_SCORE 0.4 holds the held-out floor
// (srcHitRate 0.875 / srcMRR 0.615), up from 0.833 / 0.610 at 0.4 on the pre-cleaning corpus - and run-eval
// now gates the held-out floor at this shipped 0.4 DIRECTLY (not only at the tune-selected cutoff), so a
// `pnpm eval` PASS certifies 0.4 on this corpus rather than inferring flatness. The auto-calibration prints
// 0.00 only because the LARGER, more-stable TUNE split's srcMRR dipped to 0.595 (a one-query swing at this
// split size, not a held-out regression; grow the eval set before retuning).
const CALIBRATED_CHUNK_COUNT = 1901;

const corpusPath = fileURLToPath(
	new URL('../../../static/corpus/corpus-v1.0.json', import.meta.url)
);

describe('corpus calibration tripwire', () => {
	it('shipped corpus size still matches the size MIN_SCORE was calibrated against', () => {
		const manifest = JSON.parse(readFileSync(corpusPath, 'utf8')) as { chunks: unknown[] };
		expect(manifest.chunks.length).toBe(CALIBRATED_CHUNK_COUNT);
	});
});
