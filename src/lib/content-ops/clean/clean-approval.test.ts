import { describe, it, expect } from 'vitest';
import { isCleanApproved } from './clean-approval';
import type { CleanedRef, CleanApproval } from './clean-approval';

const EXTRACTION_HASH = 'ext-hash-current';
const STALE_EXTRACTION_HASH = 'ext-hash-stale';
const CLEANED_HASH = 'clean-hash-current';
const STALE_CLEANED_HASH = 'clean-hash-stale';

const freshCleaned: CleanedRef = { extractionHash: EXTRACTION_HASH, cleanedHash: CLEANED_HASH };
const matchingApproval: CleanApproval = { decision: 'approved', cleanedHash: CLEANED_HASH };

describe('isCleanApproved', () => {
	it('fails closed when there is no cleaned/<id>.json for the source at all', () => {
		expect(isCleanApproved(EXTRACTION_HASH, null, matchingApproval)).toBe(false);
	});

	it('fails closed when the cleaned output was derived from a stale extraction (re-ingested but not re-cleaned)', () => {
		const staleCleaned: CleanedRef = {
			extractionHash: STALE_EXTRACTION_HASH,
			cleanedHash: CLEANED_HASH
		};
		expect(isCleanApproved(EXTRACTION_HASH, staleCleaned, matchingApproval)).toBe(false);
	});

	it('fails closed when the manifest carries no approval entry for the source', () => {
		expect(isCleanApproved(EXTRACTION_HASH, freshCleaned, undefined)).toBe(false);
	});

	it('fails closed when the source is still pending human review', () => {
		const pending: CleanApproval = { decision: 'pending', cleanedHash: CLEANED_HASH };
		expect(isCleanApproved(EXTRACTION_HASH, freshCleaned, pending)).toBe(false);
	});

	it('fails closed when approved, but the cleaning rules changed since approval so cleanedHash no longer matches', () => {
		// This is the case a rules change must re-open: the extraction is unchanged (extractionHash
		// still matches) and a prior approval exists, but that approval was for a DIFFERENT cleaned
		// output than the one on disk right now.
		const staleApproval: CleanApproval = { decision: 'approved', cleanedHash: STALE_CLEANED_HASH };
		expect(isCleanApproved(EXTRACTION_HASH, freshCleaned, staleApproval)).toBe(false);
	});

	it('passes only when cleaned is derived from the current extraction AND approved as this exact cleaned output', () => {
		expect(isCleanApproved(EXTRACTION_HASH, freshCleaned, matchingApproval)).toBe(true);
	});
});
