import type { RunningAffix } from './detect-running-affix';

// Mirrors detect-running-affix.ts's own VARIABLE_RUN_RE exactly: the page number the detector
// treats as "variable" between/after constant segments is an optional space, zero or more digits,
// then an optional space. Stripping must consume the identical token the detector skipped when it
// learned the constant segments, or a leftover digit (or a swallowed content character) would break
// the byte-verbatim guarantee the next pipeline stage (blocksToNormalizedText) depends on.
const VARIABLE_RUN_RE = /^\s?\d*\s?/;

// A page number in these guides is at most 3 digits (matching the corpus's own page-number definition -
// a 4-digit year, or a longer numeric id like a video URL's, is never a page number). The variable run
// after a constant affix segment is only consumed when its digit run fits this bound; a longer contiguous
// run is real content glued to the affix, and eating it would silently destroy government content. Mirrors
// detect-running-affix.ts's own MAX_PAGE_NUMBER_DIGITS so the detector and the stripper skip the identical token.
const MAX_PAGE_NUMBER_DIGITS = 3;

// A dotted leader is the classic "Title......4" table-of-contents-style page reference: 3+ dots is
// where real leaders in this corpus start (a stray ellipsis in ordinary prose never runs past 2),
// optionally trailed by whitespace and the page number itself. Anchored to the string end so this
// only ever strips the literal tail, never a mid-sentence run of dots.
const DOTTED_LEADER_STUB_RE = /\.{3,}\s*\d*\s*$/;

// A block that, once every real prefix/suffix segment is stripped, is left with nothing but a bare
// page number (and surrounding whitespace) had no real content in it to begin with, so dropping it
// entirely is safe. Deliberately narrow: a trailing digit run glued onto genuine prose (this corpus
// is full of "...since 2021" and "...up to 17%" style content) is left alone on purpose, since
// nothing short of a stub-specific signal like the dotted leader above can tell the two apart
// without risking the corpus's verbatim guarantee.
const BARE_PAGE_NUMBER_RE = /^\s*\d+\s*$/;

/**
 * Reverses a string so the suffix side of stripFused can reuse the prefix-stripping walk unmodified
 * - the same trick detect-running-affix.ts uses to find suffix segments in the first place.
 *
 * Args:
 *     s: The string to reverse.
 *
 * Returns:
 *     The string with its characters in reverse order.
 */
function reverseString(s: string): string {
	return s.split('').reverse().join('');
}

/**
 * Strips each ordered constant segment from the start of `text`, stopping at the first segment
 * that is not actually present rather than assuming the rest of the affix still applies further in.
 * After each segment removed, also consumes the variable page-number run that follows it.
 *
 * Args:
 *     text: The text to strip from the front.
 *     segments: The ordered constant segments to look for, the one nearest the true start first.
 *
 * Returns:
 *     The text with the leading segments (and their adjoining page-number runs) removed.
 */
/** Number of digit characters in a matched variable run, used to tell a page number from glued content. */
function digitCount(run: string): number {
	return (run.match(/\d/g) ?? []).length;
}

function stripLeadingSegments(text: string, segments: string[]): string {
	let result = text;
	let first = true;
	for (const segment of segments) {
		// Only in front of the FIRST segment can a leading page-number run sit (some guides print the
		// page number before the header). Skip it ONLY when doing so makes the segment match - never
		// strip a leading number off a block that simply lacks this header, since that would be content.
		if (first && !result.startsWith(segment)) {
			const lead = result.match(VARIABLE_RUN_RE)?.[0] ?? '';
			if (
				lead.length > 0 &&
				digitCount(lead) <= MAX_PAGE_NUMBER_DIGITS &&
				result.slice(lead.length).startsWith(segment)
			) {
				result = result.slice(lead.length);
			}
		}
		first = false;

		if (!result.startsWith(segment)) break;
		result = result.slice(segment.length);
		const run = result.match(VARIABLE_RUN_RE)?.[0] ?? '';
		// Consume the run only when its digits are page-number-shaped; a longer run (a URL id, a year)
		// is content glued to the affix and must be left byte-verbatim, not swallowed as a page number.
		if (digitCount(run) <= MAX_PAGE_NUMBER_DIGITS) result = result.slice(run.length);
	}
	return result;
}

/** Strip a detected running affix (its constant segments plus the variable page-number run between/
 *  around them), dotted-leader page references, and trailing page-number stubs from a block's text,
 *  leaving the remaining content byte-verbatim. */
export function stripFused(text: string, affix: RunningAffix): string {
	let result = stripLeadingSegments(text, affix.prefix);

	// affix.suffix is ordered nearest-content-first - the mirror image of prefix - so the segment
	// that actually touches the true end of the block is the LAST array entry. Reversing the text
	// once and reusing stripLeadingSegments lets the same "stop at the first absent segment, consume
	// the adjoining variable run" walk run from that end inward, instead of a second hand-written
	// walk that could quietly drift out of sync with the prefix one.
	const reversedSegments = affix.suffix.slice().reverse().map(reverseString);
	result = reverseString(stripLeadingSegments(reverseString(result), reversedSegments));

	result = result.replace(DOTTED_LEADER_STUB_RE, '');
	if (BARE_PAGE_NUMBER_RE.test(result)) result = '';

	return result.trim();
}
