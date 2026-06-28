import { describe, it, expect } from 'vitest';
import { validateSourcesSchema } from './sources-schema';

const ok = {
	source_id: 'va_disability_file',
	title: 'VA - How to File a VA Disability Claim',
	url: 'https://www.va.gov/disability/how-to-file-claim/',
	origin: 'VA',
	copyright_status: 'us_government_work_public_domain',
	legal_tier: 'confident_pd',
	content_type: 'html',
	license_notes: '17 USC 105',
	terms_reviewed_date: '2026-06-20',
	terms_notes: 'va.gov ToS permits automated read of public pages',
	redistribution_cleared: false,
	access: 'open',
	reviewed_by: 'max',
	reviewed_date: '2026-06-20',
	scrape_method: 'direct_url',
	content_hash: 'abc',
	captured_path: 'content-ops/captures/abc.html',
	captured_at: '2026-06-20T00:00:00Z',
	robots_allowed: true,
	update_check: 'monthly',
	corpus_version_first_included: '1.0'
};

describe('validateSourcesSchema', () => {
	it('accepts a conformant entry list with no errors', () => {
		expect(validateSourcesSchema([ok])).toEqual({ valid: true, errors: [] });
	});

	it('rejects non-array input with an opaque code', () => {
		expect(validateSourcesSchema({} as unknown as unknown[])).toEqual({
			valid: false,
			errors: [{ code: 'E_SOURCES_NOT_ARRAY' }]
		});
	});

	it('flags a non-https url', () => {
		const r = validateSourcesSchema([{ ...ok, url: 'http://www.va.gov/x' }]);
		expect(r.valid).toBe(false);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_URL',
			sourceId: 'va_disability_file',
			field: 'url'
		});
	});

	it('flags a bad source_id pattern', () => {
		const r = validateSourcesSchema([{ ...ok, source_id: 'VA Bad Id' }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_ID',
			sourceId: 'VA Bad Id',
			field: 'source_id'
		});
	});

	it('flags a duplicate source_id (once, for the duplicate)', () => {
		const r = validateSourcesSchema([ok, { ...ok }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_DUP_ID',
			sourceId: 'va_disability_file',
			field: 'source_id'
		});
	});

	it('flags an unknown legal_tier', () => {
		const r = validateSourcesSchema([{ ...ok, legal_tier: 'maybe_ok' }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_TIER',
			sourceId: 'va_disability_file',
			field: 'legal_tier'
		});
	});

	it('flags a non-excluded tier missing a terms review', () => {
		const r = validateSourcesSchema([{ ...ok, terms_reviewed_date: undefined }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_MISSING_REVIEW',
			sourceId: 'va_disability_file',
			field: 'terms_reviewed_date'
		});
	});

	it('flags a served original that is not redistribution_cleared', () => {
		const r = validateSourcesSchema([
			{ ...ok, content_type: 'pdf', served: true, redistribution_cleared: false }
		]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_SERVED_NOT_CLEARED',
			sourceId: 'va_disability_file',
			field: 'redistribution_cleared'
		});
	});

	it('flags an HTML source marked served (HTML is never re-hosted)', () => {
		const r = validateSourcesSchema([{ ...ok, content_type: 'html', served: true }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_HTML_SERVED',
			sourceId: 'va_disability_file',
			field: 'served'
		});
	});

	it('flags a missing required field', () => {
		const r = validateSourcesSchema([{ ...ok, origin: undefined }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_MISSING_FIELD',
			sourceId: 'va_disability_file',
			field: 'origin'
		});
	});

	it('flags a non-object entry', () => {
		const r = validateSourcesSchema([null]);
		expect(r.errors).toContainEqual({ code: 'E_SOURCES_NOT_OBJECT' });
	});

	it('flags an unknown content_type', () => {
		const r = validateSourcesSchema([{ ...ok, content_type: 'xml' }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_CONTENT_TYPE',
			sourceId: 'va_disability_file',
			field: 'content_type'
		});
	});

	it('flags an unknown update_check cadence', () => {
		const r = validateSourcesSchema([{ ...ok, update_check: 'daily' }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_CADENCE',
			sourceId: 'va_disability_file',
			field: 'update_check'
		});
	});

	it('accepts an entry with a valid ISO source_updated_date', () => {
		expect(validateSourcesSchema([{ ...ok, source_updated_date: '2026-04-15' }])).toEqual({
			valid: true,
			errors: []
		});
	});

	it('flags a non-ISO source_updated_date (MM/DD/YYYY)', () => {
		const r = validateSourcesSchema([{ ...ok, source_updated_date: '04/15/2026' }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_DATE',
			sourceId: 'va_disability_file',
			field: 'source_updated_date'
		});
	});

	it('flags an impossible month in source_updated_date', () => {
		const r = validateSourcesSchema([{ ...ok, source_updated_date: '2026-13-01' }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_DATE',
			sourceId: 'va_disability_file',
			field: 'source_updated_date'
		});
	});

	it('flags a non-calendar day in source_updated_date (Feb 30)', () => {
		const r = validateSourcesSchema([{ ...ok, source_updated_date: '2026-02-30' }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_DATE',
			sourceId: 'va_disability_file',
			field: 'source_updated_date'
		});
	});

	// the reviewed_by / reviewed_date branch of E_SOURCES_MISSING_REVIEW.
	it('flags a non-excluded tier missing reviewed_by', () => {
		const r = validateSourcesSchema([{ ...ok, reviewed_by: undefined }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_MISSING_REVIEW',
			sourceId: 'va_disability_file',
			field: 'reviewed_date'
		});
	});

	it('flags a non-excluded tier missing reviewed_date', () => {
		const r = validateSourcesSchema([{ ...ok, reviewed_date: undefined }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_MISSING_REVIEW',
			sourceId: 'va_disability_file',
			field: 'reviewed_date'
		});
	});

	// the legal boolean flags must be real booleans. A YAML truthy scalar (`served: yes`) parses
	// as the STRING "yes", which would silently skip the served / redistribution legal gate.
	it('flags a non-boolean served flag', () => {
		const r = validateSourcesSchema([{ ...ok, served: 'yes' }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_BOOL',
			sourceId: 'va_disability_file',
			field: 'served'
		});
	});

	it('flags a non-boolean redistribution_cleared flag', () => {
		const r = validateSourcesSchema([{ ...ok, redistribution_cleared: 'true' }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_BOOL',
			sourceId: 'va_disability_file',
			field: 'redistribution_cleared'
		});
	});

	it('flags a non-boolean robots_allowed flag', () => {
		const r = validateSourcesSchema([{ ...ok, robots_allowed: 1 }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_BOOL',
			sourceId: 'va_disability_file',
			field: 'robots_allowed'
		});
	});

	// provenance dates (reviewed_date / terms_reviewed_date) must be real ISO dates - the same
	// calendar check as source_updated_date. A legal record should not carry a garbage vet date.
	it('flags a non-ISO reviewed_date', () => {
		const r = validateSourcesSchema([{ ...ok, reviewed_date: '06/21/2026' }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_DATE',
			sourceId: 'va_disability_file',
			field: 'reviewed_date'
		});
	});

	it('flags a non-ISO terms_reviewed_date', () => {
		const r = validateSourcesSchema([{ ...ok, terms_reviewed_date: '2026/06/20' }]);
		expect(r.errors).toContainEqual({
			code: 'E_SOURCES_BAD_DATE',
			sourceId: 'va_disability_file',
			field: 'terms_reviewed_date'
		});
	});
});
