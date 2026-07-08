/**
 * PII-policy guard.
 *
 * Project hard rule: PII never leaves the device. Server-side SvelteKit
 * source (`+server.ts`, `*.server.ts`, `hooks.server.ts`) must never reference a
 * ProfileV1 PII field. v1.0 ships ZERO server files, so this is a forward guard for
 * Phase 3+ backend work - it fails the test suite (pre-commit + CI) the moment a
 * server file names a profile PII field.
 *
 * Implemented as a vitest test rather than a bash CI step:
 * cross-platform, runs in pre-commit AND CI, TDD-native.
 */

/**
 * ProfileV1 PII field accessors (src/lib/profile/types.ts) plus the historical raw
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
	/\b_profileBytes\b/
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
