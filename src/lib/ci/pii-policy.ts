/**
 * PII-policy guard.
 *
 * Project hard rule: PII never leaves the device. Server-side SvelteKit
 * source (`+server.ts`, `*.server.ts`, `hooks.server.ts`) must never reference a
 * ProfileV1 PII field. The one server route today, the feedback endpoint, reads none;
 * the guard fails the test suite (pre-commit + CI) the moment any server file names a
 * profile PII field.
 *
 * Implemented as a vitest test rather than a bash CI step:
 * cross-platform, runs in pre-commit AND CI, TDD-native.
 */

/**
 * The ProfileV1 personal-data field names, the one list a new field is added to. A test checks that the dot patterns
 * and the three field-form patterns below each cover every name.
 */
export const PII_FIELD_NAMES: readonly string[] = [
	'eaos',
	'rate',
	'rank',
	'yearsOfService',
	'anticipatedDisabilityRating',
	'familyStatus',
	'intendedPath',
	'geographicDestination',
	'specialSituations',
	'skillbridgeStart',
	'terminalLeaveStart'
];

/**
 * ProfileV1 PII field accessors (src/lib/profile/types.ts), the keystore per-install identifier
 * (src/lib/keystore/record.ts - a device-tracking value that must never egress), plus the historical raw
 * decrypted-bytes marker. Word-boundary anchored so `.rate` does not match `.rateLimit`.
 */
export const FORBIDDEN_PII_PATTERNS: readonly RegExp[] = [
	/\.eaos\b/,
	/\.rate\b/,
	/\.rank\b/,
	/\.yearsOfService\b/,
	/\.anticipatedDisabilityRating\b/,
	/\.familyStatus\b/,
	/\.intendedPath\b/,
	/\.geographicDestination\b/,
	/\.specialSituations\b/,
	/\.skillbridgeStart\b/,
	/\.terminalLeaveStart\b/,
	/\b_profileBytes\b/,
	/\binstallUuid\b/,
	// The same fields read without a dot, which the patterns above cannot see: by bracket (`profile['eaos']`), as a key
	// inside braces on one line (`const { eaos } = profile`), or as a key alone at the start of a line (a destructure
	// split over several lines). Prose is left alone: "a figure, rate, or deadline" has no braces and no leading key.
	/\[\s*['"`](?:eaos|rate|rank|yearsOfService|anticipatedDisabilityRating|familyStatus|intendedPath|geographicDestination|specialSituations|skillbridgeStart|terminalLeaveStart)['"`]\s*\]/,
	/\{[^}]*\b(?:eaos|rate|rank|yearsOfService|anticipatedDisabilityRating|familyStatus|intendedPath|geographicDestination|specialSituations|skillbridgeStart|terminalLeaveStart)\b[^}]*\}/,
	/^\s*(?:eaos|rate|rank|yearsOfService|anticipatedDisabilityRating|familyStatus|intendedPath|geographicDestination|specialSituations|skillbridgeStart|terminalLeaveStart)\s*(?=[,:=]|$)/
];

/**
 * The user's own Anthropic key: it goes browser-direct to Anthropic and nowhere else, so it is never named in code
 * that calls our own servers (the retrieve path, the Worker, feedback, server files).
 */
export const BYO_KEY_PATTERNS: readonly RegExp[] = [/\b(?:apiKey|readApiKey)\b/, /x-api-key/i];

export interface PiiViolation {
	path: string;
	token: string;
	line: number;
}

/**
 * Scan provided file contents for forbidden PII tokens.
 *
 * Pure: callers supply the file list (the test globs the real server-file tree),
 * so the detector itself has no filesystem dependency and is trivially testable.
 *
 * Args:
 *   files: array of { path, content } to scan.
 *   patterns: the tokens to look for; the profile fields and the install identifier unless given.
 *
 * Returns:
 *   one PiiViolation per (file, line, matching pattern); empty array when clean.
 */
export function scanForPiiTokens(
	files: ReadonlyArray<{ path: string; content: string }>,
	patterns: readonly RegExp[] = FORBIDDEN_PII_PATTERNS
): PiiViolation[] {
	const violations: PiiViolation[] = [];
	for (const file of files) {
		const lines = file.content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? '';
			for (const pattern of patterns) {
				if (pattern.test(line)) {
					violations.push({ path: file.path, token: pattern.source, line: i + 1 });
				}
			}
		}
	}
	return violations;
}

/**
 * Modules that hold or derive personal data. Code that can send a request off the device must not import them, so a
 * value cannot reach it under a new name - the case the field patterns cannot see. Matched on `$lib/...` and relative
 * specifiers only, so a platform module such as `node:crypto` is not caught.
 */
export const FORBIDDEN_IMPORT_PATTERN =
	/(?:^\$lib\/|^\.\.?\/(?:.*\/)?)(?:profile|keystore|crypto|db|timeline|calendar)(?:\/|$)/;

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/**
 * Scan provided file contents for imports of the personal-data modules.
 *
 * Args:
 *   files: array of { path, content } to scan.
 *
 * Returns:
 *   one PiiViolation per forbidden import, with the specifier as its token; empty array when clean.
 */
export function scanForPiiImports(
	files: ReadonlyArray<{ path: string; content: string }>
): PiiViolation[] {
	const violations: PiiViolation[] = [];
	for (const file of files) {
		const lines = file.content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			for (const match of (lines[i] ?? '').matchAll(IMPORT_SPECIFIER)) {
				const specifier = match[1] ?? '';
				if (FORBIDDEN_IMPORT_PATTERN.test(specifier)) {
					violations.push({ path: file.path, token: specifier, line: i + 1 });
				}
			}
		}
	}
	return violations;
}
