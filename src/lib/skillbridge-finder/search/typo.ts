/**
 * True when `a` and `b` differ by at most one inserted, deleted or substituted character (Levenshtein distance
 * 1 or less). Stops at the first difference rather than filling a table, since it runs against every word in
 * the index on each keystroke.
 */
export function withinOneEdit(a: string, b: string): boolean {
	const la = a.length;
	const lb = b.length;

	let i = 0;
	while (i < la && i < lb && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	if (i === la && i === lb) return true;

	// Past the first difference the rest must line up: skipping one character of the longer word, or
	// replacing one character when the lengths are equal.
	const skipA = la >= lb ? 1 : 0;
	const skipB = lb >= la ? 1 : 0;
	for (let ia = i + skipA, ib = i + skipB; ia < la || ib < lb; ia++, ib++) {
		if (a.charCodeAt(ia) !== b.charCodeAt(ib)) return false;
	}
	return true;
}
