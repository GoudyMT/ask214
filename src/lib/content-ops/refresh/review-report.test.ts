import { describe, it, expect } from 'vitest';
import { buildReviewReport, type ReviewInput } from './review-report';

const changed: ReviewInput = {
	sourceId: 'va_intent_to_file',
	status: 'changed',
	oldHash: 'aaa',
	newHash: 'bbb',
	reason: 'content hash differs',
	url: 'https://www.va.gov/resources/your-intent-to-file-a-va-claim/',
	scrapeMethod: 'direct_url',
	updateCheck: 'monthly',
	diff: { added: ['A newly inserted paragraph.'], removed: [] }
};

const manual: ReviewInput = {
	sourceId: 'tsp_separation',
	status: 'manual-check-required',
	oldHash: 'ccc',
	reason: 'source cannot be auto-fetched',
	url: 'https://www.tsp.gov/leaving-the-uniformed-services/',
	scrapeMethod: 'manual',
	updateCheck: 'monthly',
	runbook: {
		downloadHow: 'Save Page As -> Web Page, HTML Only',
		placementPath: 'content-ops/staged/manual-html/tsp_separation.html'
	}
};

describe('buildReviewReport', () => {
	it('renders the changed source with its delta and the 17 USC 105 checklist', () => {
		const { markdown } = buildReviewReport([changed], '2026-07-06');
		expect(markdown).toContain('va_intent_to_file');
		expect(markdown).toContain('A newly inserted paragraph.');
		expect(markdown).toContain('17 USC 105');
		expect(markdown).toContain('third-party');
	});

	it('renders a full 5-part runbook for a manual source', () => {
		const { markdown } = buildReviewReport([manual], '2026-07-06');
		expect(markdown).toContain(manual.url);
		expect(markdown).toContain('Save Page As');
		expect(markdown).toContain('content-ops/staged/manual-html/tsp_separation.html');
		expect(markdown).toContain('pnpm ingest tsp_separation');
		expect(markdown).toContain('pnpm eval');
	});

	it('builds a manifest with every source defaulting to decision: pending', () => {
		const { manifest } = buildReviewReport([changed, manual], '2026-07-06');
		expect(manifest.generatedAt).toBe('2026-07-06');
		expect(manifest.sources.map((s) => s.decision)).toEqual(['pending', 'pending']);
		expect(manifest.sources[0]?.sourceId).toBe('va_intent_to_file');
	});

	it('carries the detected source updated date into the manifest when the change record has one', () => {
		const withDate: ReviewInput = { ...changed, newDate: '2026-05-01' };
		const { manifest } = buildReviewReport([withDate], '2026-07-06');
		expect(manifest.sources[0]?.sourceUpdatedDate).toBe('2026-05-01');
	});

	it('omits sourceUpdatedDate (no undefined key) when the change record has none', () => {
		const { manifest } = buildReviewReport([changed], '2026-07-06');
		expect(Object.prototype.hasOwnProperty.call(manifest.sources[0], 'sourceUpdatedDate')).toBe(
			false
		);
	});
});
