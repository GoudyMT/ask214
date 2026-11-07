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

// The start of a glob call, past an optional type argument (which may hold parentheses, as a function type does).
const GLOB_START = new RegExp(
	`(?<![A-Za-z0-9_$.${QUOTES}])import[.]meta[.]glob(?:Eager)?${IMPORT_GAP}(?:<[^;]{0,400}?>${IMPORT_GAP})?[(]`,
	'g'
);
// One string, closed by the quote it opened with, or any other single character; white space and comments before it
// are passed over whole, so a quote or a bracket inside a comment is never read.
const STRING = [...QUOTES].map((q) => `${q}[^${q}${LINE_BREAKS}]*${q}`).join('|');
const GLOB_TOKEN = new RegExp(`${IMPORT_GAP}(${STRING}|[^${WHITE_SPACE}])`, 'y');
const OPENERS = '([{';
const CLOSERS = ')]}';

/**
 * Every string a glob call is given, list items and options (a base folder) included, with where it starts in the
 * text. The call is read to its own close parenthesis; the search for the next call goes on from there, so the whole
 * file is read once.
 */
function globSpecifiers(text: string): { specifier: string; at: number }[] {
	const found: { specifier: string; at: number }[] = [];
	GLOB_START.lastIndex = 0;
	for (let call = GLOB_START.exec(text); call; call = GLOB_START.exec(text)) {
		GLOB_TOKEN.lastIndex = call.index + call[0].length;
		// A sticky search that fails sets lastIndex back to 0, so the place read up to is kept apart.
		let readTo = GLOB_TOKEN.lastIndex;
		let depth = 0;
		for (let token = GLOB_TOKEN.exec(text); token; token = GLOB_TOKEN.exec(text)) {
			readTo = GLOB_TOKEN.lastIndex;
			const value = token[1] ?? '';
			if (value.length > 1) {
				found.push({
					specifier: value.slice(1, -1),
					at: token.index + token[0].length - value.length
				});
			} else if (OPENERS.includes(value)) depth++;
			else if (CLOSERS.includes(value) && depth-- === 0) break;
		}
		GLOB_START.lastIndex = Math.max(GLOB_START.lastIndex, readTo);
	}
	return found;
}

const LOCAL_SPECIFIER = /^(?:[#$]lib\/|\.\.?\/|\/src\/)/;
// Glob wildcards, brace and bracket sets, and a template value: a local folder named by one of these is a pattern the
// scan cannot match against the banned names, so it is refused.
const PATTERN_CHARS = String.fromCharCode(42, 63, 91, 93, 123, 125);
const TEMPLATE_VALUE = String.fromCharCode(36, 123);

/** Whether an import or glob specifier names a banned folder, or could reach one through a pattern in its folder. */
function isForbidden(specifier: string): boolean {
	if (FORBIDDEN_IMPORT_PATTERN.test(specifier)) return true;
	if (!LOCAL_SPECIFIER.test(specifier)) return false;
	const folder = specifier.slice(0, specifier.lastIndexOf('/') + 1);
	return [...folder].some((c) => PATTERN_CHARS.includes(c)) || folder.includes(TEMPLATE_VALUE);
}

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
		// One import can match several patterns; each string is counted once, by where it ends. An import is placed on the
		// line it starts on, a later glob item on its own line.
		const seen = new Set<number>();
		const found = [
			...[
				...file.content.matchAll(IMPORT_SPECIFIER),
				...file.content.matchAll(IMPORT_PAST_COMMENTS)
			].map((match) => ({
				specifier: match[2] ?? '',
				at: match.index,
				end: match.index + match[0].length
			})),
			...globSpecifiers(file.content).map((g) => ({
				...g,
				end: g.at + g.specifier.length + 2
			}))
		];
		for (const { specifier, at, end } of found) {
			if (seen.has(end)) continue;
			seen.add(end);
			if (isForbidden(specifier)) {
				const line = file.content.slice(0, at).split('\n').length;
				violations.push({ path: file.path, token: specifier, line });
			}
		}
	}
	return violations;
}
