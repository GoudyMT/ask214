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
 *
 * Returns:
 *   one PiiViolation per (file, line, matching pattern); empty array when clean.
 */
export function scanForPiiTokens(
	files: ReadonlyArray<{ path: string; content: string }>
): PiiViolation[] {
	const violations: PiiViolation[] = [];
	for (const file of files) {
		const lines = file.content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? '';
			for (const pattern of FORBIDDEN_PII_PATTERNS) {
				if (pattern.test(line)) {
					violations.push({ path: file.path, token: pattern.source, line: i + 1 });
				}
			}
		}
	}
	return violations;
}
