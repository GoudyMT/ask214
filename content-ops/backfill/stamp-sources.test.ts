import { describe, test, expect } from 'vitest';
import { parse } from 'yaml';
import { stampSourcesYaml } from './stamp-sources';

// A miniature sources.yaml: a header comment + two commented entries, mirroring the real registry's shape.
// The point of the stamper is to add capture fields WITHOUT disturbing any of these comments.
const FIXTURE = `# Sources registry - LEGAL RECORD (header comment must survive).
# 17 USC 105 public-domain work only.

- source_id: va_x
  title: 'VA X'
  content_type: html # inline comment on content_type
  scrape_method: direct_url

- source_id: tap_y
  title: 'TAP Y'
  content_type: pdf
  scrape_method: staged_pdf
`;

const NOW = '2026-06-25T12:00:00.000Z';
const incoming = {
	va_x: { contentHash: 'aaa', contentType: 'html' as const },
	tap_y: { contentHash: 'bbb', contentType: 'pdf' as const }
};

describe('stampSourcesYaml', () => {
	test('sets the four capture fields on each matched entry', () => {
		const parsed = parse(stampSourcesYaml(FIXTURE, incoming, NOW));
		expect(parsed.find((e) => e.source_id === 'va_x')).toMatchObject({
			content_hash: 'aaa',
			captured_path: 'content-ops/captures/aaa.html',
			captured_at: NOW,
			robots_allowed: true
		});
		expect(parsed.find((e) => e.source_id === 'tap_y').captured_path).toBe(
			'content-ops/captures/bbb.pdf'
		);
	});

	test('preserves the header + inline comments (the legal record is not mangled)', () => {
		const out = stampSourcesYaml(FIXTURE, incoming, NOW);
		expect(out).toContain('# Sources registry - LEGAL RECORD (header comment must survive).');
		expect(out).toContain('# 17 USC 105 public-domain work only.');
		expect(out).toContain('# inline comment on content_type');
	});

	test('leaves existing fields + values intact', () => {
		const va = parse(stampSourcesYaml(FIXTURE, incoming, NOW)).find((e) => e.source_id === 'va_x');
		expect(va.title).toBe('VA X');
		expect(va.scrape_method).toBe('direct_url');
	});

	test('captured_at round-trips as a string (not coerced to a Date)', () => {
		const va = parse(stampSourcesYaml(FIXTURE, incoming, NOW)).find((e) => e.source_id === 'va_x');
		expect(typeof va.captured_at).toBe('string');
	});

	test('a second run is byte-identical (idempotent at the yaml layer)', () => {
		const once = stampSourcesYaml(FIXTURE, incoming, NOW);
		// re-stamp the output with the SAME hashes but a DIFFERENT now -> unchanged hash keeps captured_at
		const twice = stampSourcesYaml(once, incoming, '2099-01-01T00:00:00.000Z');
		expect(twice).toBe(once);
	});

	test('ignores entries not in the incoming map', () => {
		const tap = parse(stampSourcesYaml(FIXTURE, { va_x: incoming.va_x }, NOW)).find(
			(e) => e.source_id === 'tap_y'
		);
		expect('content_hash' in tap).toBe(false);
	});

	test('does not reflow long lines (yaml default 80-col wrapping would corrupt the legal-record diff)', () => {
		// a >80-char value: yaml's default lineWidth folds it across lines on toString, touching entries we
		// never stamped. The stamper must keep long scalars on one line so the diff stays minimal.
		const longNote =
			'Public va.gov page; no ToS restriction on reading public content; app is unofficial, not endorsed by VA.';
		const fixture = `- source_id: keep_me
  title: 'Keep'
  content_type: html
  terms_notes: '${longNote}'
`;
		const out = stampSourcesYaml(
			fixture,
			{ keep_me: { contentHash: 'x', contentType: 'html' } },
			NOW
		);
		expect(out).toContain(`terms_notes: '${longNote}'`);
		expect(out).toContain('content_hash: x');
	});
});
