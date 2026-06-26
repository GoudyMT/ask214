const SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/gi;

/**
 * Scans an HTML string for resource-loading `src=` URLs (img / script / iframe / audio / video / source)
 * whose origin differs from the page's. Navigation `<a href>` links are intentionally NOT flagged - an
 * off-origin .gov link is wanted, not an asset load. Used to assert the sanitized audit copy emits no
 * network request if rendered. Same-origin + relative URLs are allowed. Pure.
 */
export function findOffOriginUrls(html: string, pageOrigin: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(SRC_RE)) {
		const url = m[1];
		if (url === undefined || !/^https?:\/\//i.test(url)) continue;
		if (originOf(url) !== pageOrigin) out.push(url);
	}
	return out;
}

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return '';
	}
}
