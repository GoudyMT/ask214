import { describe, it, expect } from 'vitest';
import { buildReviewHtml } from './review-html';

const sample = [
	{
		sourceId: 'tap_va_womens_health',
		report: {
			dropped: [{ page: 2, kind: 'toc', preview: 'ii Table of Contents ...' }],
			stripped: [
				{
					page: 9,
					before: 'VA Acronym List <b>Module 1 Acronyms...Appendix C</b>',
					after: 'VA Acronym List'
				}
			],
			review: []
		}
	}
];

describe('buildReviewHtml', () => {
	it('renders a self-contained HTML doc with a section per source', () => {
		const html = buildReviewHtml(sample);
		expect(html).toContain('<!doctype html>');
		expect(html).toContain('<style>'); // inline, no external assets
		expect(html).toContain('tap_va_womens_health');
		expect(html).toContain('1 dropped');
		expect(html).toContain('1 stripped');
	});

	it('escapes HTML in the source text so the report cannot inject markup', () => {
		const html = buildReviewHtml(sample);
		// the literal <b> from the source must be shown as text, not rendered as a tag
		expect(html).toContain('&lt;b&gt;');
		expect(html).not.toContain('VA Acronym List <b>Module 1');
	});

	it('shows both the before and the after of a strip', () => {
		const html = buildReviewHtml(sample);
		expect(html).toContain('VA Acronym List &lt;b&gt;Module 1 Acronyms...Appendix C&lt;/b&gt;');
		expect(html).toMatch(/after[\s\S]*VA Acronym List</i);
	});

	it('renders an empty-but-valid page when nothing changed', () => {
		const html = buildReviewHtml([]);
		expect(html).toContain('<!doctype html>');
		expect(html).toContain('0 sources with changes');
	});
});
