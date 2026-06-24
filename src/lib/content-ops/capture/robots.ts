/**
 * Minimal robots.txt allow check (master spec 8.5: honor robots.txt always). Picks the group naming our
 * User-agent (substring match) else the `*` group, then applies the longest-matching path rule (an Allow
 * overrides a broader Disallow). Deliberately NOT a full RFC 9309 engine - our sources are direct-url
 * .gov/.mil pages; this covers their robots.txt without the complexity (YAGNI per A2-D1). The build
 * script records the result as `robots_allowed` and hard-stops a disallowed source.
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
	const ua = userAgent.toLowerCase();
	const key = [...groups.keys()].find((k) => k !== '*' && ua.includes(k)) ?? '*';
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
