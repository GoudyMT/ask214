/**
 * The `sources.yaml` schema + pure validator (A1, the legal foundation). Takes ALREADY-PARSED entries
 * (the `yaml` parse happens in content-ops/validate-sources.mjs, the only place that dep is imported -
 * keeping it out of `src/` per the no-third-party-runtime-JS rule). Returns a STRUCTURED result rather
 * than throwing interpolated messages, so opaque codes satisfy `mtc/no-input-in-error` and the offending
 * sourceId/field travel as DATA. Collects ALL violations (does not stop at the first).
 */

export type LegalTier = 'confident_pd' | 'verified_gray_zone' | 'excluded';
export type ContentType = 'html' | 'pdf';
export type UpdateCadence = 'weekly' | 'monthly';

export type SourceEntry = {
	source_id: string;
	title: string;
	url: string;
	origin: string;
	copyright_status: string;
	legal_tier: LegalTier;
	content_type: ContentType;
	license_notes: string;
	terms_reviewed_date?: string;
	terms_notes?: string;
	redistribution_cleared?: boolean;
	served?: boolean; // true only for a served (re-hosted) original; PDFs only
	access: string;
	reviewed_by?: string;
	reviewed_date?: string;
	scrape_method: string;
	content_hash?: string;
	captured_path?: string;
	captured_at?: string;
	robots_allowed?: boolean;
	update_check: UpdateCadence;
	corpus_version_first_included: string;
};

export type ValidationError = { code: string; sourceId?: string; field?: string };
export type ValidationResult = { valid: boolean; errors: ValidationError[] };

const ID_RE = /^[a-z0-9_]+$/;
const TIERS = new Set(['confident_pd', 'verified_gray_zone', 'excluded']);
const CONTENT_TYPES = new Set(['html', 'pdf']);
const CADENCES = new Set(['weekly', 'monthly']);
const REQUIRED_STRINGS = [
	'source_id',
	'title',
	'url',
	'origin',
	'copyright_status',
	'legal_tier',
	'content_type',
	'license_notes',
	'access',
	'scrape_method',
	'update_check',
	'corpus_version_first_included'
] as const;

export function validateSourcesSchema(entries: unknown[]): ValidationResult {
	if (!Array.isArray(entries)) return { valid: false, errors: [{ code: 'E_SOURCES_NOT_ARRAY' }] };

	const errors: ValidationError[] = [];
	const seen = new Set<string>();

	for (const raw of entries) {
		if (typeof raw !== 'object' || raw === null) {
			errors.push({ code: 'E_SOURCES_NOT_OBJECT' });
			continue;
		}
		const e = raw as Record<string, unknown>;
		const sid = typeof e.source_id === 'string' ? e.source_id : undefined;

		for (const field of REQUIRED_STRINGS) {
			if (typeof e[field] !== 'string') {
				errors.push({ code: 'E_SOURCES_MISSING_FIELD', sourceId: sid, field });
			}
		}
		if (sid !== undefined && !ID_RE.test(sid))
			errors.push({ code: 'E_SOURCES_BAD_ID', sourceId: sid, field: 'source_id' });
		if (sid !== undefined) {
			if (seen.has(sid))
				errors.push({ code: 'E_SOURCES_DUP_ID', sourceId: sid, field: 'source_id' });
			seen.add(sid);
		}
		if (typeof e.url === 'string' && !e.url.startsWith('https://'))
			errors.push({ code: 'E_SOURCES_BAD_URL', sourceId: sid, field: 'url' });
		if (typeof e.legal_tier === 'string' && !TIERS.has(e.legal_tier))
			errors.push({ code: 'E_SOURCES_BAD_TIER', sourceId: sid, field: 'legal_tier' });
		if (typeof e.content_type === 'string' && !CONTENT_TYPES.has(e.content_type))
			errors.push({ code: 'E_SOURCES_BAD_CONTENT_TYPE', sourceId: sid, field: 'content_type' });
		if (typeof e.update_check === 'string' && !CADENCES.has(e.update_check))
			errors.push({ code: 'E_SOURCES_BAD_CADENCE', sourceId: sid, field: 'update_check' });

		// A non-excluded tier requires a human copyright review AND a terms-of-use review.
		if (e.legal_tier !== 'excluded') {
			if (typeof e.reviewed_by !== 'string' || typeof e.reviewed_date !== 'string')
				errors.push({ code: 'E_SOURCES_MISSING_REVIEW', sourceId: sid, field: 'reviewed_date' });
			if (typeof e.terms_reviewed_date !== 'string')
				errors.push({
					code: 'E_SOURCES_MISSING_REVIEW',
					sourceId: sid,
					field: 'terms_reviewed_date'
				});
		}

		// Served (re-hosted) originals: PDFs only, and must be redistribution-cleared.
		if (e.served === true) {
			if (e.content_type !== 'pdf')
				errors.push({ code: 'E_SOURCES_HTML_SERVED', sourceId: sid, field: 'served' });
			if (e.redistribution_cleared !== true)
				errors.push({
					code: 'E_SOURCES_SERVED_NOT_CLEARED',
					sourceId: sid,
					field: 'redistribution_cleared'
				});
		}
	}

	return { valid: errors.length === 0, errors };
}
