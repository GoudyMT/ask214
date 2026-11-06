/**
 * PII-policy guard.
 *
 * Project hard rule: PII never leaves the device. Code that can send data off the device - server source, the online
 * Ask path, the Worker, the feedback path, and the Ask store and home route that build the online requests - must never
 * name a ProfileV1 PII field or the install identifier, and (the home route aside) must not import the modules that
 * hold personal data. The retrieve path, the Worker, feedback and server files must not name the user's own API key;
 * the home route does, because it hands the key to the Anthropic call. The guard fails the test suite (pre-commit +
 * CI) the moment one breaks a rule. It reads names and imports, not values: the online request test
 * (tests/e2e/egress-canary.e2e.ts) checks what actually leaves, the key included.
 *
 * Implemented as a vitest test rather than a bash CI step:
 * cross-platform, runs in pre-commit AND CI, TDD-native.
 */

/**
 * The ProfileV1 personal-data field names. Each name is also spelled out in the patterns below (literal regexes, so
 * the static scan in CI accepts them); a test fails when a pattern and this list drift apart.
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
	'terminalLeaveStart',
	'separationPath',
	'lastBackupAt',
	'backupGenProfile',
	'backupGenTimeline',
	'backupGenCalendar'
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
	/\.separationPath\b/,
	/\.lastBackupAt\b/,
	/\.backupGenProfile\b/,
	/\.backupGenTimeline\b/,
	/\.backupGenCalendar\b/,
	/\b_profileBytes\b/,
	/\binstallUuid\b/,
	// The same fields read without a dot, which the patterns above cannot see: by bracket (`profile['eaos']`), as a key
	// inside braces on one line (`const { eaos } = profile`), or as a key alone at the start of a line (a destructure
	// split over several lines). The last form leaves out "rate" and "rank": they are ordinary words, and a wrapped line
	// of prose can start with one. A name scan cannot see a value under a new name at all; the online request test
	// (tests/e2e/egress-canary.e2e.ts) checks the values that leave the device - but no screen sets rate or rank yet, so
	// it covers them only once one does and the test seeds them.
	/\[\s*['"`](?:eaos|rate|rank|yearsOfService|anticipatedDisabilityRating|familyStatus|intendedPath|geographicDestination|specialSituations|skillbridgeStart|terminalLeaveStart|separationPath|lastBackupAt|backupGenProfile|backupGenTimeline|backupGenCalendar)['"`]\s*\]/,
	/\{[^}]*\b(?:eaos|rate|rank|yearsOfService|anticipatedDisabilityRating|familyStatus|intendedPath|geographicDestination|specialSituations|skillbridgeStart|terminalLeaveStart|separationPath|lastBackupAt|backupGenProfile|backupGenTimeline|backupGenCalendar)\b[^}]*\}/,
	/^\s*(?:eaos|yearsOfService|anticipatedDisabilityRating|familyStatus|intendedPath|geographicDestination|specialSituations|skillbridgeStart|terminalLeaveStart|separationPath|lastBackupAt|backupGenProfile|backupGenTimeline|backupGenCalendar)\s*(?=[,:=]|$)/
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
 * Modules that hold or derive personal data. Code that can send a request off the device must not import them. This
 * stops a direct import only: a module the code imports can still pass a value along, which the online request test
 * (tests/e2e/egress-canary.e2e.ts) checks instead. Matched on `#lib/...`, relative and `/src/...` specifiers, with the
 * banned folder anywhere in the path, so a platform module such as `node:crypto` or a route such as `/timeline` is
 * not caught.
 */
export const FORBIDDEN_IMPORT_PATTERN =
	/(?:^[#$]lib\/|^\.\.?\/|^\/src\/)(?:.*\/)?(?:profile|keystore|crypto|db|timeline|calendar|backup)(?:\/|$)/;

// Any quote, including a template literal, and any whitespace - line breaks too - between `import(` or `from` and the
// specifier, so the scan runs over the whole file rather than one line at a time. The specifier itself stops at a
// line break: a quoted word ending in "from" in a string or comment would otherwise run on to the next quote and
// swallow a real import.
const IMPORT_SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\.meta\.glob(?:Eager)?\s*\(\s*\[?\s*|\bimport\s+)(['"`])([^'"`\r\n]+)\1/g;

const QUOTES = String.fromCharCode(39, 34, 96);
const LINE_BREAKS = String.fromCharCode(10, 13);
const WHITE_SPACE = String.fromCharCode(32, 9, 10, 11, 12, 13, 160);
// What may sit between the words of an import: white space and comments. A block comment ends at its first close and a
// line comment at its line end, and each alternative starts on its own character. So there is one way through a gap
// (the scan cannot backtrack badly on a long comment) and a quote inside a comment is only part of the comment.
export const IMPORT_GAP = `(?:[${WHITE_SPACE}]|[/][*](?:[^*]|[*](?![/]))*[*][/]|[/][/][^${LINE_BREAKS}]*[${LINE_BREAKS}])*`;
// The pattern above, reading past a comment such as `@vite-ignore` wherever one can sit. Inside `import(` a computed
// specifier may lead up to the string, which is what `@vite-ignore` is for; the run stops at the end of the call. A word
// straight after a quote is a string's content, not an import.
export const IMPORT_PAST_COMMENTS = new RegExp(
	`(?<![A-Za-z0-9_$.${QUOTES}])(?:import[.]meta[.]glob(?:Eager)?${IMPORT_GAP}[(]${IMPORT_GAP}[[]?|import${IMPORT_GAP}[(]${IMPORT_GAP}[^${QUOTES});/]*|import|from)${IMPORT_GAP}([${QUOTES}])([^${QUOTES}${LINE_BREAKS}]+)[${QUOTES}]`,
	'g'
);

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
		// An import with no comment matches both patterns, at the same place.
		const seen = new Set<number>();
		for (const match of [
			...file.content.matchAll(IMPORT_SPECIFIER),
			...file.content.matchAll(IMPORT_PAST_COMMENTS)
		]) {
			if (seen.has(match.index)) continue;
			seen.add(match.index);
			const specifier = match[2] ?? '';
			if (FORBIDDEN_IMPORT_PATTERN.test(specifier)) {
				const line = file.content.slice(0, match.index).split('\n').length;
				violations.push({ path: file.path, token: specifier, line });
			}
		}
	}
	return violations;
}
