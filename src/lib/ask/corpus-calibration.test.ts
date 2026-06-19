import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// MIN_SCORE (src/lib/ask/store.svelte.ts = 0.4) was calibrated against this exact SHIPPED corpus size.
// The cosine-score distribution compresses as the corpus grows, so a size change can erode the margin
// between the weakest valid lead and MIN_SCORE and start silently dropping real answers (spec section
// 15 #1). The eval re-gate (content-ops/run-eval.mjs) that re-confirms the margin is manual-only and not
// wired into CI, so this tripwire fails the build on ANY corpus-size change: when it fails, re-run the
// eval, re-confirm the margin holds (or recalibrate MIN_SCORE), THEN bump CALIBRATED_CHUNK_COUNT.
const CALIBRATED_CHUNK_COUNT = 9;

const corpusPath = fileURLToPath(
	new URL('../../../static/corpus/corpus-v1.0.json', import.meta.url)
);

describe('corpus calibration tripwire', () => {
	it('shipped corpus size still matches the size MIN_SCORE was calibrated against', () => {
		const manifest = JSON.parse(readFileSync(corpusPath, 'utf8')) as { chunks: unknown[] };
		expect(manifest.chunks.length).toBe(CALIBRATED_CHUNK_COUNT);
	});
});
