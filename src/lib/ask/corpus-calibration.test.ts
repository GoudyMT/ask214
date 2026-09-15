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
// + appendix-ToC removal): MIN_SCORE 0.4 held, MEASURING srcHitRate 0.875 / srcMRR 0.618 on held-out. Those
// are readings, not the gate - the enforced floor lives in run-eval.mjs (FLOOR) and is 0.83 / 0.6 as of
// 2026-09-15. Re-measured the same day after the benchmark's multi-source correction: held-out 0.868 / 0.641
// at the shipped cutoff, which is BELOW the 0.875 reading above and still comfortably over the real gate - and
// run-eval gates the held-out floor at this shipped 0.4 DIRECTLY (not only at the tune-selected cutoff), so a
// `pnpm eval` PASS certifies 0.4 on this corpus. The auto-calibration selects 0.4 on its own (the TUNE split
// holds the floor at every cutoff, srcMRR 0.614). Removing the boilerplate held the source-hit floor flat;
// its value is chunk cleanliness for synthesis + highlighting, not the source-level ranking metric.
// Re-confirmed 2026-09-15 at 1991 chunks: eight lookup-shaped gov pages added to close enumerated
// benchmark gaps (1845 -> 1991). Procedure followed exactly as this comment prescribes - rebuild, re-run
// the eval, confirm the margin, THEN bump: held-out srcHitRate 0.842 / srcMRR 0.613 at the shipped 0.40
// cutoff, over the enforced 0.83 / 0.6 floor, and the auto-calibration selects 0.40 on its own. Both answer
// gates passed in the same run (device tier 1 39.3%, online 47.4%).
//
// This growth is also the clearest case yet of the margin-erosion this comment warns about. Measured BEFORE
// the benchmark's ground truth was updated to credit the new pages, srcMRR read 0.600 against its own 0.6
// floor - zero margin - and every answer metric looked DOWN. That was an instrument artifact: reachability
// is scored against the expected source, and the items still named the old ones, so a new page answering
// correctly counted as a miss by construction. With the ground truth corrected the same corpus reads
// 0.613, and the reachable ceiling rose 76.3% -> 78.5% on device and 83.0% -> 85.2% online. Do not read a
// rate move after a corpus change until the benchmark can SEE the change.
//
// The prior 1845-chunk reading was 0.868 / 0.641; srcHitRate is genuinely lower here (0.842), which is the
// dilution cost of 146 more chunks competing for the same top-5.
const CALIBRATED_CHUNK_COUNT = 1991;

const corpusPath = fileURLToPath(
	new URL('../../../static/corpus/corpus-v1.0.2.json', import.meta.url)
);

describe('corpus calibration tripwire', () => {
	it('shipped corpus size still matches the size MIN_SCORE was calibrated against', () => {
		const manifest = JSON.parse(readFileSync(corpusPath, 'utf8')) as { chunks: unknown[] };
		expect(manifest.chunks.length).toBe(CALIBRATED_CHUNK_COUNT);
	});
});
