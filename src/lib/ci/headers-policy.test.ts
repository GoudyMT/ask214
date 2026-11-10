import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { headersFor, parseHeadersFile } from './headers-policy';

describe('parseHeadersFile', () => {
	it('splits path blocks and their indented headers', () => {
		const parsed = parseHeadersFile(
			'/*\n  Referrer-Policy: no-referrer\n\n/wizard\n  Cache-Control: no-store\n'
		);
		expect(parsed.get('/*')).toEqual({ 'Referrer-Policy': 'no-referrer' });
		expect(parsed.get('/wizard')).toEqual({ 'Cache-Control': 'no-store' });
	});

	// Cloudflare applies both blocks of a path written twice; reading only the last would drop the first block's
	// headers from every rendered page and from the preview, silently.
	it('refuses a path written as two blocks', () => {
		expect(() =>
			parseHeadersFile('/docs/*\n  X-Robots-Tag: noindex\n\n/docs/*\n  Cache-Control: no-store\n')
		).toThrow('E_HEADERS_DUPLICATE_PATH');
	});
});

describe('headersFor', () => {
	const rules = parseHeadersFile(
		'/*\n  Referrer-Policy: no-referrer\n\n/settings\n  Cache-Control: no-store\n\n/settings/*\n  Cache-Control: no-store\n\n/docs/*\n  X-Robots-Tag: noindex\n'
	);

	it('gives every path the global block, and a listed path its own block too', () => {
		expect(headersFor(rules, '/settings')).toEqual({
			'Referrer-Policy': 'no-referrer',
			'Cache-Control': 'no-store'
		});
		expect(headersFor(rules, '/ask')).toEqual({ 'Referrer-Policy': 'no-referrer' });
	});

	it('matches a /* block under its folder only, never a path that only starts with its name', () => {
		expect(headersFor(rules, '/settings/backup')['Cache-Control']).toBe('no-store');
		expect(headersFor(rules, '/settingsx')['Cache-Control']).toBeUndefined();
		expect(headersFor(rules, '/docs')['X-Robots-Tag']).toBeUndefined();
	});

	// SvelteKit routes on the decoded path, so `/%73ettings` draws the settings page and must get its headers too.
	it('matches a path written with escapes the way the router reads it', () => {
		expect(headersFor(rules, '/%73ettings')['Cache-Control']).toBe('no-store');
		expect(headersFor(rules, '/%73ettings/backup')['Cache-Control']).toBe('no-store');
	});
});

describe('_headers policy (P1b)', () => {
	const headers = parseHeadersFile(readFileSync(join(process.cwd(), '_headers'), 'utf8'));

	it('global Referrer-Policy is tightened to no-referrer', () => {
		// no-referrer: never leak a referrer, even same-origin. Privacy-first default; OAuth
		// (v1.1) uses state/redirect_uri not Referer, and we run no referral analytics.
		expect(headers.get('/*')?.['Referrer-Policy']).toBe('no-referrer');
	});

	it('profile-touching routes set Cache-Control: no-store (BFCache opt-out)', () => {
		// PII routes must not be cached / BFCache-restored with decrypted state in memory (memory
		// hygiene). Home '/' is included - it reads the profile store + holds the BYO-key closure.
		// /settings/security is NOT included - it does not exist in v1.0 (passphrase route -> v1.1).
		// /documents lists the guides this device saved, which is a record of what the member read.
		for (const path of ['/', '/wizard', '/settings', '/settings/*', '/timeline', '/documents']) {
			expect(headers.get(path)?.['Cache-Control'], `${path} must set no-store`).toBe('no-store');
		}
	});

	it('the global security headers are locked at their hardened values', () => {
		// The rendered pages take these from the file as written, so a weakened HSTS (dropped preload / lower
		// max-age) or a deleted X-Frame-Options would ship on every page. Pin the exact values so a regression
		// fails the build here.
		const global = headers.get('/*');
		expect(global?.['Strict-Transport-Security']).toBe(
			'max-age=63072000; includeSubDomains; preload'
		);
		expect(global?.['X-Content-Type-Options']).toBe('nosniff');
		expect(global?.['X-Frame-Options']).toBe('DENY');
		expect(global?.['Permissions-Policy']).toBe(
			'camera=(), microphone=(), geolocation=(), interest-cohort=()'
		);
		expect(global?.['Cross-Origin-Opener-Policy']).toBe('same-origin');
		expect(global?.['Cross-Origin-Resource-Policy']).toBe('same-origin');
	});

	// A served document is our altered copy - its pictures removed - and a search hit would open it bare, with no
	// note that it is a copy and no link to the official original. Search engines are asked not to list them.
	it('asks search engines not to list the served documents', () => {
		expect(headers.get('/docs/*')?.['X-Robots-Tag']).toBe('noindex');
	});

	// The PDF library's worker runs the code that parses each document, and a worker takes its policy from its own
	// response, not from the page: without this it could fetch anywhere. It fetches nothing - the page hands it
	// the document - so it gets nothing (proven against the built site served with these headers). The library
	// module in the same folder is imported by the page, which ignores a policy on a module.
	it("locks the PDF library's worker to no network", () => {
		expect(headers.get('/pdf-worker/*')?.['Content-Security-Policy']).toBe("default-src 'none'");
	});

	// The backup key worker takes its policy from its own response too. It derives a key from words the page hands
	// it and fetches, imports and evaluates nothing, so it gets nothing; a worker that could reach the network
	// could send a passphrase out.
	it("/backup-kdf/* has default-src 'none'", () => {
		expect(headers.get('/backup-kdf/*')?.['Content-Security-Policy']).toBe("default-src 'none'");
	});

	// The on-device answer worker reads every question a member asks, and the page's policy does not reach it. Its
	// own policy keeps it on this site: its chunks, the WASM runtime and the model are all served from here, and
	// 'wasm-unsafe-eval' lets the runtime compile without allowing JavaScript eval.
	it('keeps the on-device answer worker on this site', () => {
		expect(headers.get('/_app/immutable/workers/*')?.['Content-Security-Policy']).toBe(
			"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'"
		);
	});

	// The preview server and the rendered pages let a later block win, while Cloudflare may join two values for one
	// header. With no header set twice for one path, both read the file the same way.
	it('never sets one header in two blocks that match the same path', () => {
		for (const path of headers.keys()) {
			const sample = path.endsWith('/*') ? `${path.slice(0, -1)}x` : path;
			const seen = new Set<string>();
			for (const [other, values] of headers) {
				if (Object.keys(headersFor(new Map([[other, values]]), sample)).length === 0) continue;
				// Header names are case-insensitive, so Cache-Control and cache-control are one header.
				for (const name of Object.keys(values).map((key) => key.toLowerCase())) {
					expect(seen.has(name), `${name} set twice for ${sample}`).toBe(false);
					seen.add(name);
				}
			}
		}
	});

	// Every vendored or served static folder is named in NOTICE, with its license or its public-domain basis.
	it('NOTICE names the page reader, the served documents and the backup key worker', () => {
		const notice = readFileSync(join(process.cwd(), 'NOTICE'), 'utf8');
		expect(notice).toContain('static/pdf-worker/');
		expect(notice).toContain('static/docs/');
		expect(notice).toContain('static/backup-kdf/');
	});
});
