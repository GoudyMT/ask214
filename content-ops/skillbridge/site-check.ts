/**
 * The one GET that decides whether an organization's own website may be shown. The address comes from a provider's
 * email, so everything on this path is hostile input: the check refuses private and special addresses, connects to
 * the very address it vetted (a second DNS lookup could answer differently), follows a redirect only to the same
 * host or its `www.` twin, stops at a deadline and a byte cap, and returns a yes or no with no page content.
 */

import dns from 'node:dns';
import https from 'node:https';
import type http from 'node:http';
import net from 'node:net';
import { SITE_MAX_BYTES, SITE_MAX_REDIRECTS, SITE_TIMEOUT_MS, USER_AGENT } from './config.ts';

export type Resolved = { address: string; family: 4 | 6 };
export type SiteDeps = {
	lookup(host: string): Promise<Resolved[]>;
	/** Production: `isPublicAddress`. */
	isAllowedAddress(address: string): boolean;
	get(
		target: {
			address: string;
			family: 4 | 6;
			host: string;
			path: string;
			protocol: 'https:' | 'http:';
		},
		limits: { timeoutMs: number; maxBytes: number }
	): Promise<{ status: number; location?: string; contentType: string; body: string }>;
};
/** The part of `https.request` the transport uses; a test swaps in `http.request` aimed at a stub server. */
export type RequestFn = (
	options: http.RequestOptions & { servername?: string },
	callback: (res: http.IncomingMessage) => void
) => http.ClientRequest;

const HTTPS_PORT = 443;
const HEX = 16;
const BYTE = 256;

/** A page carrying any of these (lowercased) is a for-sale or parking page, not the company's site. */
const PARKED_MARKERS: readonly string[] = [
	'domain is for sale',
	'buy this domain',
	'this domain may be for sale',
	'domain parking',
	'parked free',
	'parkingcrew',
	'sedoparking',
	'bodis.com',
	'hugedomains',
	'afternic',
	'dan.com',
	'this domain is parked'
];

function parseIPv4(text: string): number[] | null {
	const parts = text.split('.');
	if (parts.length !== 4) return null;
	const octets = parts.map((part) => (part.length > 0 && part.length <= 3 ? Number(part) : NaN));
	return octets.every((n) => Number.isInteger(n) && n >= 0 && n < BYTE) ? octets : null;
}

function isPublicIPv4(octets: readonly number[]): boolean {
	const [a = 0, b = 0, c = 0] = octets;
	if (a === 0 || a === 10 || a === 127) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 0 && c === 0) return false;
	if (a === 192 && b === 168) return false;
	if (a === 198 && (b === 18 || b === 19)) return false;
	// 224/4 multicast, 240/4 reserved and 255.255.255.255 broadcast.
	return a < 224;
}

/** Eight 16-bit groups, or null; a zone id ("%eth0") is refused as unparseable. */
function parseIPv6(address: string): number[] | null {
	if (net.isIP(address) !== 6 || address.includes('%')) return null;
	let text = address;
	const lastColon = text.lastIndexOf(':');
	const tail = text.slice(lastColon + 1);
	if (tail.includes('.')) {
		const v4 = parseIPv4(tail);
		if (v4 === null) return null;
		const [a = 0, b = 0, c = 0, d = 0] = v4;
		text =
			text.slice(0, lastColon + 1) +
			(a * BYTE + b).toString(HEX) +
			':' +
			(c * BYTE + d).toString(HEX);
	}
	const halves = text.split('::');
	const groups = (part: string): number[] =>
		part === '' ? [] : part.split(':').map((group) => parseInt(group, HEX));
	if (halves.length === 1) {
		const all = groups(text);
		return all.length === 8 ? all : null;
	}
	if (halves.length !== 2) return null;
	const head = groups(halves[0] ?? '');
	const rest = groups(halves[1] ?? '');
	const gap = 8 - head.length - rest.length;
	return gap < 0 ? null : [...head, ...new Array<number>(gap).fill(0), ...rest];
}

function isPublicIPv6(g: readonly number[]): boolean {
	const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = g;
	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d, which also covers :: and ::1) carry an IPv4
	// address in the last 32 bits: that address decides.
	if (g.slice(0, 5).every((group) => group === 0) && (g5 === 0xffff || g5 === 0))
		return isPublicIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
	// Everything else must be global unicast (2000::/3). That alone leaves out the NAT64 prefixes (64:ff9b::/96 and
	// 64:ff9b:1::/48), SIIT (::ffff:0:0/96), site-local (fec0::/10), unique-local, link-local and multicast, all of
	// which can reach a private IPv4 address or never name a public site.
	if ((g0 & 0xe000) !== 0x2000) return false;
	// 6to4 (2002::/16) embeds an IPv4 address that a relay delivers to.
	if (g0 === 0x2002) return false;
	// 2001::/23 is for protocol assignments, Teredo (2001::/32) among them; 2001:db8::/32 is for documentation.
	if (g0 === 0x2001 && (g1 < 0x200 || g1 === 0xdb8)) return false;
	// 3fff::/20 is for documentation.
	return !(g0 === 0x3fff && g1 < 0x1000);
}

/** True only for an IP address that is globally routable: not private, loopback, link-local, reserved or multicast. */
export function isPublicAddress(address: string): boolean {
	const family = net.isIP(address);
	if (family === 4) {
		const octets = parseIPv4(address);
		return octets !== null && isPublicIPv4(octets);
	}
	if (family === 6) {
		const groups = parseIPv6(address);
		return groups !== null && isPublicIPv6(groups);
	}
	return false;
}

/** A parsed plain-https URL (no login, default port), or null. */
function plainHttps(raw: string, base?: string): URL | null {
	try {
		const url = new URL(raw, base);
		const plain =
			url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === '';
		return plain ? url : null;
	} catch {
		return null;
	}
}

const wwwTwin = (host: string): string => (host.startsWith('www.') ? host.slice(4) : 'www.' + host);

function isHtml(contentType: string): boolean {
	const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
	return mime === 'text/html' || mime === 'application/xhtml+xml';
}

const isParked = (body: string): boolean => {
	const text = body.toLowerCase();
	return PARKED_MARKERS.some((marker) => text.includes(marker));
};

async function follow(url: string, deps: SiteDeps): Promise<boolean> {
	const start = plainHttps(url);
	if (start === null) return false;
	const home = start.hostname;
	let current = start;
	for (let redirects = 0; ; redirects++) {
		// One lookup per hop; the connection below uses its vetted answer, never a second resolution.
		const addresses = await deps.lookup(current.hostname);
		const first = addresses[0];
		if (first === undefined || !addresses.every((a) => deps.isAllowedAddress(a.address)))
			return false;
		const reply = await deps.get(
			{
				address: first.address,
				family: first.family,
				host: current.hostname,
				path: current.pathname + current.search,
				protocol: 'https:'
			},
			{ timeoutMs: SITE_TIMEOUT_MS, maxBytes: SITE_MAX_BYTES }
		);
		const redirect = reply.status >= 300 && reply.status < 400 && reply.location;
		if (redirect) {
			if (redirects >= SITE_MAX_REDIRECTS) return false;
			const next = plainHttps(reply.location ?? '', current.href);
			if (next === null || (next.hostname !== home && next.hostname !== wwwTwin(home)))
				return false;
			current = next;
			continue;
		}
		return reply.status === 200 && isHtml(reply.contentType) && !isParked(reply.body);
	}
}

/** Whether `url` is a live, non-parked page on its own host. Every refusal and every error is `false`. */
export async function checkSite(url: string, deps: SiteDeps): Promise<boolean> {
	try {
		return await follow(url, deps);
	} catch {
		return false;
	}
}

/**
 * The transport: one GET to the given address, with the host named for TLS and certificates verified. It never
 * follows a redirect, stops after `timeoutMs` in all (not merely between bytes) and keeps at most `maxBytes`.
 */
export function createGet(
	request: RequestFn = https.request,
	port: number = HTTPS_PORT
): SiteDeps['get'] {
	return (target, limits) =>
		new Promise((resolve, reject) => {
			if (target.protocol !== 'https:') {
				reject(new Error('E_SITE_NOT_HTTPS'));
				return;
			}
			// One deadline over the whole exchange (connect, TLS, headers and body), not an idle timeout that a
			// server trickling a byte at a time would never trip. Aborting it destroys the request and response.
			const signal = AbortSignal.timeout(limits.timeoutMs);
			let settled = false;
			const settle = (done: () => void): void => {
				if (settled) return;
				settled = true;
				done();
			};
			const fail = (error: Error): void =>
				settle(() => reject(signal.aborted ? new Error('E_SITE_TIMEOUT') : error));
			const req = request(
				{
					host: target.address,
					family: target.family,
					port,
					method: 'GET',
					path: target.path,
					servername: target.host,
					headers: { Host: target.host, 'User-Agent': USER_AGENT, Accept: 'text/html' },
					agent: false,
					signal
				},
				(res) => {
					const parts: Buffer[] = [];
					let size = 0;
					const finish = (): void =>
						settle(() => {
							const { location } = res.headers;
							const type = res.headers['content-type'];
							resolve({
								status: res.statusCode ?? 0,
								contentType: typeof type === 'string' ? type : '',
								body: Buffer.concat(parts).toString('utf8'),
								...(typeof location === 'string' ? { location } : {})
							});
							req.destroy();
						});
					res.on('data', (chunk: Buffer) => {
						if (settled) return;
						const room = limits.maxBytes - size;
						parts.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
						size += Math.min(chunk.length, room);
						if (size >= limits.maxBytes) finish();
					});
					res.on('end', finish);
					res.on('error', fail);
					res.on('close', () => fail(new Error('E_SITE_ABORTED')));
				}
			);
			req.on('error', fail);
			req.end();
		});
}

/** The production wiring: the system resolver, the public-address rule, and the https transport. */
export function createSiteDeps(): SiteDeps {
	return {
		lookup: async (host) =>
			(await dns.promises.lookup(host, { all: true })).map(({ address, family }): Resolved => ({
				address,
				family: family === 6 ? 6 : 4
			})),
		isAllowedAddress: isPublicAddress,
		get: createGet()
	};
}

export function createSiteCheck(): (url: string) => Promise<boolean> {
	const deps = createSiteDeps();
	return (url) => checkSite(url, deps);
}
