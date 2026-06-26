/**
 * Minimal robots.txt allow check (honor robots.txt always). Picks the group whose name is a prefix of
 * our product token (the UA before "/") else the `*` group, then applies the longest-matching path rule
 * (an Allow overrides a broader Disallow). Deliberately NOT a full robots engine - our sources are
 * direct-url .gov/.mil pages; this covers their robots.txt without the complexity. The build script
 * records the result as `robots_allowed` and hard-stops a disallowed source.
 */

type Rule = { allow: boolean; path: string };

/** Parse into UA-group -> rules. A blank `Disallow:` means "no restriction" (adds no rule). */
function parse(robotsTxt: string): Map<string, Rule[]> {
	const groups = new Map<string, Rule[]>();
	let agents: string[] = [];
	for (const raw of robotsTxt.split(/\r?\n/)) {
		const line = raw.replace(/#.*$/, '').trim();
		if (!line) continue;
		const idx = line.indexOf(':');
		if (idx === -1) continue;
		const field = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();
		if (field === 'user-agent') {
			agents = [value.toLowerCase()];
			if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
		} else if ((field === 'disallow' || field === 'allow') && agents.length) {
			if (value === '' && field === 'disallow') continue; // blank Disallow = no restriction
			for (const a of agents) (groups.get(a) ?? []).push({ allow: field === 'allow', path: value });
		}
	}
	return groups;
}

export function isPathAllowed(robotsTxt: string, userAgent: string, path: string): boolean {
	const groups = parse(robotsTxt);
	// Match on the product token (the part before "/"), not the whole UA string - otherwise a robots group
	// naming any substring of our UA comment (e.g. "contact" / "pending") could hijack the decision and flip
	// a Disallow to allow (fail-open). A group matches when our product token starts with its name.
	const product = (userAgent.toLowerCase().split('/')[0] ?? '').trim();
	const key = [...groups.keys()].find((k) => k !== '*' && product.startsWith(k)) ?? '*';
	const rules = groups.get(key) ?? [];
	let decision = true;
	let matchLen = -1;
	for (const r of rules) {
		if (path.startsWith(r.path) && r.path.length > matchLen) {
			decision = r.allow;
			matchLen = r.path.length;
		}
	}
	return decision;
}
