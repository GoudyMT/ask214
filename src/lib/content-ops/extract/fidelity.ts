export type FidelityIssue = 'E_FIDELITY_EMPTY' | 'E_FIDELITY_LOW_COVERAGE' | 'E_FIDELITY_GARBLED';
export type FidelityResult = { ok: boolean; issues: FidelityIssue[] };

/** True for U+FFFD (replacement) or a C0 control char other than tab (9) / newline (10) / CR (13). */
function isBadChar(code: number): boolean {
	return code === 0xfffd || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d);
}

/**
 * The A2-D6 gross-failure sanity check (one of the two auto-gate primitives): flags an extraction that is
 * empty, suspiciously thin per page (a parse failure / wrong tool), or garbled (replacement / control
 * chars over a ratio - an encoding failure or binary-as-text). Structured opaque-code result
 * (mtc/no-input-in-error); the build script gates on it and - with trigramSimilarity - decides
 * auto-accept vs flag-for-review. Pure.
 */
export function checkExtractionSanity(
	text: string,
	opts: { pages?: number; minCharsPerPage?: number; maxBadRatio?: number } = {}
): FidelityResult {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { ok: false, issues: ['E_FIDELITY_EMPTY'] };

	const issues: FidelityIssue[] = [];
	const minPerPage = opts.minCharsPerPage ?? 100;
	if (opts.pages !== undefined && opts.pages > 0 && trimmed.length / opts.pages < minPerPage)
		issues.push('E_FIDELITY_LOW_COVERAGE');

	let bad = 0;
	for (let i = 0; i < trimmed.length; i++) if (isBadChar(trimmed.charCodeAt(i))) bad++;
	if (bad / trimmed.length > (opts.maxBadRatio ?? 0.02)) issues.push('E_FIDELITY_GARBLED');

	return { ok: issues.length === 0, issues };
}
