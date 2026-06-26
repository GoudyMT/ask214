/**
 * Pull the staged PDF filename from a source entry's `terms_notes` (which carries "...File: <name>.pdf...").
 * Returns null when no marker is present. Pure + tested because a WRONG match maps a source to the wrong
 * staged PDF, and the fidelity gate would NOT catch it (it would compare the wrong PDF against itself
 * and agree) - so the regex behavior is pinned here rather than living untested inside the build script.
 */
export function stagedFileName(termsNotes: string | null | undefined): string | null {
	const m = /File:\s*(\S+\.pdf)/i.exec(termsNotes ?? '');
	return m?.[1] ?? null;
}
