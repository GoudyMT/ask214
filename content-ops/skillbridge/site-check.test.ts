import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { SITE_MAX_BYTES, SITE_TIMEOUT_MS, USER_AGENT } from './config.ts';
import {
	checkSite,
	createGet,
	createSiteCheck,
	createSiteDeps,
	isPublicAddress,
	type RequestFn,
	type Resolved,
	type SiteDeps
} from './site-check.ts';

type Target = Parameters<SiteDeps['get']>[0];
type Reply = { status: number; location?: string; contentType?: string; body?: string };

const PUBLIC_IP = '93.184.216.34';
const TARGET: Target = {
	address: '127.0.0.1',
	family: 4,
	host: 'site.test',
	path: '/',
	protocol: 'https:'
};
const HOME: Reply = { status: 200, body: '<html><body>Welcome to our company</body></html>' };

/** Deps with scripted DNS and pages (key: host + path); records every lookup and every connection target. */
function makeDeps(routes: Record<string, Reply>, dns: Record<string, string[]> = {}) {
	const lookups: string[] = [];
	const gets: Target[] = [];
	const limits: { timeoutMs: number; maxBytes: number }[] = [];
	const deps: SiteDeps = {
		lookup: async (host) => {
			lookups.push(host);
			return (dns[host] ?? [PUBLIC_IP]).map((address): Resolved => ({
				address,
				family: address.includes(':') ? 6 : 4
			}));
		},
		isAllowedAddress: isPublicAddress,
		get: async (target, l) => {
			gets.push(target);
			limits.push(l);
			const reply = routes[target.host + target.path];
			if (reply === undefined) throw new Error('E_TEST_NO_ROUTE');
			return {
				status: reply.status,
				contentType: reply.contentType ?? 'text/html; charset=utf-8',
				body: reply.body ?? '',
				...(reply.location === undefined ? {} : { location: reply.location })
			};
		}
	};
	return { deps, lookups, gets, limits };
}

describe('isPublicAddress', () => {
	test('refuses every private, loopback, link-local, reserved and multicast range, edge to edge', () => {
		const refused = [
			'0.0.0.0',
			'0.255.255.255',
			'10.0.0.0',
			'10.255.255.255',
			'100.64.0.0',
			'100.127.255.255',
			'127.0.0.1',
			'127.255.255.255',
			'169.254.169.254',
			'172.16.0.0',
			'172.31.255.255',
			'192.0.0.1',
			'192.168.0.1',
			'192.168.255.255',
			'198.18.0.0',
			'198.19.255.255',
			'224.0.0.1',
			'239.255.255.255',
			'240.0.0.1',
			'255.255.255.255',
			'::',
			'::1',
			'fc00::1',
			'fdff:ffff::1',
			'fe80::1',
			'febf::1',
			'ff02::1',
			'::ffff:127.0.0.1',
			'::ffff:7f00:1',
			'::ffff:10.0.0.1',
			'::ffff:a00:1',
			'0:0:0:0:0:ffff:c0a8:1',
			'::127.0.0.1',
			'::10.0.0.1',
			'::7f00:1',
			'fe80::1%eth0',
			'localhost',
			'',
			'1.2.3',
			'1.2.3.4.5',
			'256.1.1.1',
			'example.test'
		];
		expect(refused.filter((address) => isPublicAddress(address))).toEqual([]);
	});

	test('passes public addresses, including the ones just outside each refused range', () => {
		const allowed = [
			'8.8.8.8',
			'93.184.216.34',
			'1.1.1.1',
			'9.255.255.255',
			'11.0.0.0',
			'100.63.255.255',
			'100.128.0.0',
			'126.255.255.255',
			'128.0.0.1',
			'169.253.255.255',
			'169.255.0.0',
			'172.15.255.255',
			'172.32.0.0',
			'192.0.1.1',
			'192.167.255.255',
			'192.169.0.0',
			'198.17.255.255',
			'198.20.0.0',
			'223.255.255.255',
			'2606:4700:4700::1111',
			'2001:4860:4860::8888',
			'::ffff:8.8.8.8'
		];
		expect(allowed.filter((address) => !isPublicAddress(address))).toEqual([]);
	});
});

// A DNS answer in these forms makes a gateway (or the OS) deliver the request to the IPv4 address inside it, or
// belongs to space that is never a public site: only global unicast outside them may be connected to.
describe('isPublicAddress: IPv6 forms that translate to private or reserved space', () => {
	test('refuses NAT64, local NAT64, 6to4, SIIT, site-local, Teredo, documentation and non-global space', () => {
		const refused = [
			'64:ff9b::7f00:1',
			'64:ff9b::a00:1',
			'64:ff9b::',
			'64:ff9b::ffff:ffff',
			'64:ff9b:1::a00:1',
			'64:ff9b:1:ffff:ffff:ffff:ffff:ffff',
			'2002:c0a8:101::1',
			'2002::',
			'2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
			'::ffff:0:7f00:1',
			'::ffff:0:a00:1',
			'0:0:0:0:ffff:0:c0a8:1',
			'fec0::1',
			'feff:ffff::1',
			'2001::1',
			'2001:0:4136:e378:8000:63bf:3fff:fdd2',
			'2001:1ff:ffff::1',
			'2001:db8::1',
			'2001:db8:ffff:ffff::1',
			'3fff::1',
			'3fff:fff:ffff::1',
			'1fff:ffff::1',
			'4000::1'
		];
		expect(refused.filter((address) => isPublicAddress(address))).toEqual([]);
	});

	test('passes global unicast addresses just outside each of those ranges', () => {
		const allowed = [
			'2606:4700::1',
			'2000::1',
			'2001:200::1',
			'2001:db7:ffff::1',
			'2001:db9::1',
			'2001:ffff::1',
			'2003::1',
			'3fff:1000::1',
			'2a00:1450::1',
			'2400:cb00::1'
		];
		expect(allowed.filter((address) => !isPublicAddress(address))).toEqual([]);
	});
});

describe('checkSite', () => {
	test('a live HTML home page passes, on the address lookup returned, after one lookup', async () => {
		const { deps, lookups, gets, limits } = makeDeps({ 'site.test/': HOME });
		await expect(checkSite('https://site.test/', deps)).resolves.toBe(true);
		expect(lookups).toEqual(['site.test']);
		expect(gets).toEqual([
			{ address: PUBLIC_IP, family: 4, host: 'site.test', path: '/', protocol: 'https:' }
		]);
		expect(limits).toEqual([{ timeoutMs: SITE_TIMEOUT_MS, maxBytes: SITE_MAX_BYTES }]);
	});

	test('connects to the first address when the host has several public ones', async () => {
		const { deps, gets } = makeDeps(
			{ 'site.test/': HOME },
			{ 'site.test': ['2606:4700:4700::1111', PUBLIC_IP] }
		);
		await expect(checkSite('https://site.test/', deps)).resolves.toBe(true);
		expect(gets.map((g) => [g.address, g.family])).toEqual([['2606:4700:4700::1111', 6]]);
	});

	test('a host with any private address is refused before any connection', async () => {
		const { deps, gets } = makeDeps(
			{ 'site.test/': HOME },
			{ 'site.test': [PUBLIC_IP, '10.0.0.5'] }
		);
		await expect(checkSite('https://site.test/', deps)).resolves.toBe(false);
		expect(gets).toEqual([]);
	});

	test('a host that resolves to nothing is refused', async () => {
		const { deps, gets } = makeDeps({ 'site.test/': HOME }, { 'site.test': [] });
		await expect(checkSite('https://site.test/', deps)).resolves.toBe(false);
		expect(gets).toEqual([]);
	});

	test('a URL with a scheme, login or port other than plain https is refused with no lookup', async () => {
		const { deps, lookups } = makeDeps({ 'site.test/': HOME });
		for (const url of [
			'http://site.test/',
			'https://user:secret@site.test/',
			'https://site.test:8443/',
			'ftp://site.test/',
			'not a url'
		])
			await expect(checkSite(url, deps), url).resolves.toBe(false);
		expect(lookups).toEqual([]);
	});

	test('the default https port written out is still the plain site', async () => {
		const { deps } = makeDeps({ 'site.test/': HOME });
		await expect(checkSite('https://site.test:443/', deps)).resolves.toBe(true);
	});

	test('a redirect to any other host is refused and never connected to', async () => {
		for (const location of [
			'https://evil.test/',
			'//evil.test/',
			'https://sub.site.test/',
			'https://site.test.evil.test/',
			'https://evilsite.test/',
			'https://www.www.site.test/'
		]) {
			const { deps, gets } = makeDeps({
				'site.test/': { status: 302, location },
				'evil.test/': HOME,
				'sub.site.test/': HOME,
				'site.test.evil.test/': HOME,
				'evilsite.test/': HOME,
				'www.www.site.test/': HOME
			});
			await expect(checkSite('https://site.test/', deps), location).resolves.toBe(false);
			expect(
				gets.map((g) => g.host),
				location
			).toEqual(['site.test']);
		}
	});

	test('a redirect between the bare host and its www twin is followed, with a fresh lookup', async () => {
		const toWww = makeDeps({
			'site.test/': { status: 301, location: 'https://www.site.test/' },
			'www.site.test/': HOME
		});
		await expect(checkSite('https://site.test/', toWww.deps)).resolves.toBe(true);
		expect(toWww.lookups).toEqual(['site.test', 'www.site.test']);

		const fromWww = makeDeps({
			'www.site.test/': { status: 301, location: 'https://site.test/' },
			'site.test/': HOME
		});
		await expect(checkSite('https://www.site.test/', fromWww.deps)).resolves.toBe(true);
		expect(fromWww.lookups).toEqual(['www.site.test', 'site.test']);
	});

	test('the redirect target is looked up again and refused when it now resolves to a private address', async () => {
		const { deps, gets } = makeDeps(
			{
				'site.test/': { status: 302, location: 'https://www.site.test/' },
				'www.site.test/': HOME
			},
			{ 'www.site.test': ['192.168.1.10'] }
		);
		await expect(checkSite('https://site.test/', deps)).resolves.toBe(false);
		expect(gets.map((g) => g.host)).toEqual(['site.test']);
	});

	test('a redirect to http, or to a login or another port, is refused', async () => {
		for (const location of [
			'http://site.test/',
			'https://user:secret@site.test/',
			'https://site.test:8443/'
		]) {
			const { deps, gets } = makeDeps({
				'site.test/': { status: 302, location },
				'site.test/next': HOME
			});
			await expect(checkSite('https://site.test/', deps), location).resolves.toBe(false);
			expect(gets).toHaveLength(1);
		}
	});

	test('three redirects are followed and a fourth is refused', async () => {
		const chain = (hops: number) => {
			const routes: Record<string, Reply> = {};
			for (let hop = 0; hop < hops; hop++)
				routes['site.test/' + (hop === 0 ? '' : 'r' + hop)] = {
					status: 302,
					location: '/r' + (hop + 1)
				};
			routes['site.test/r' + hops] = HOME;
			return makeDeps(routes);
		};
		const three = chain(3);
		await expect(checkSite('https://site.test/', three.deps)).resolves.toBe(true);
		expect(three.gets).toHaveLength(4);
		const four = chain(4);
		await expect(checkSite('https://site.test/', four.deps)).resolves.toBe(false);
		expect(four.gets).toHaveLength(4);
	});

	test('a parked or for-sale page does not pass, whatever its letter case', async () => {
		for (const body of [
			'<h1>This Domain Is For Sale</h1>',
			'<a href="https://x.test">Buy this domain</a>',
			'<script src="https://sedoparking.test/x.js"></script>',
			'<p>Hosted by HugeDomains</p>'
		]) {
			const { deps } = makeDeps({ 'site.test/': { status: 200, body } });
			await expect(checkSite('https://site.test/', deps), body).resolves.toBe(false);
		}
	});

	test('anything but a 200 HTML page fails', async () => {
		const replies: Reply[] = [
			{ status: 404 },
			{ status: 500 },
			{ status: 204 },
			{ status: 302 },
			{ status: 200, contentType: 'application/pdf' },
			{ status: 200, contentType: 'application/json', body: '{}' },
			{ status: 200, contentType: '' }
		];
		for (const reply of replies) {
			const { deps } = makeDeps({ 'site.test/': reply });
			await expect(checkSite('https://site.test/', deps), JSON.stringify(reply)).resolves.toBe(
				false
			);
		}
	});

	test('a lookup or a connection that throws is a plain false, not an error', async () => {
		const { deps } = makeDeps({});
		await expect(checkSite('https://site.test/', deps)).resolves.toBe(false);
		const broken: SiteDeps = {
			...deps,
			lookup: async () => {
				throw new Error('E_TEST_DNS');
			}
		};
		await expect(checkSite('https://site.test/', broken)).resolves.toBe(false);
	});
});

describe('the production get, against a stub server on 127.0.0.1', () => {
	const open: http.Server[] = [];

	async function stub(handler: http.RequestListener): Promise<number> {
		const server = http.createServer(handler);
		open.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		return (server.address() as AddressInfo).port;
	}

	afterEach(async () => {
		for (const server of open.splice(0)) {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	test('the Host and User-Agent go out, and checkSite passes the page', async () => {
		const seen: { host?: string | undefined; agent?: string | undefined } = {};
		const port = await stub((req, res) => {
			seen.host = req.headers.host;
			seen.agent = req.headers['user-agent'];
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end('<html>Hello</html>');
		});
		const deps: SiteDeps = {
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isAllowedAddress: (address) => address === '127.0.0.1',
			get: createGet(http.request, port)
		};
		await expect(checkSite('https://site.test/', deps)).resolves.toBe(true);
		expect(seen).toEqual({ host: 'site.test', agent: USER_AGENT });
	});

	test('a server that never answers is given up on at the timeout', async () => {
		const port = await stub(() => {});
		const get = createGet(http.request, port);
		const started = Date.now();
		await expect(get(TARGET, { timeoutMs: 150, maxBytes: 1000 })).rejects.toThrow('E_SITE_TIMEOUT');
		expect(Date.now() - started).toBeLessThan(3000);
		const deps: SiteDeps = {
			lookup: async () => [{ address: '127.0.0.1', family: 4 }],
			isAllowedAddress: () => true,
			get: (t, limits) => get(t, { ...limits, timeoutMs: 150 })
		};
		await expect(checkSite('https://site.test/', deps)).resolves.toBe(false);
	});

	test('a server that trickles bytes to stay under an idle timeout is still cut off at the deadline', async () => {
		const port = await stub((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			const timer = setInterval(() => res.write('x'), 20);
			res.on('close', () => clearInterval(timer));
		});
		const get = createGet(http.request, port);
		await expect(get(TARGET, { timeoutMs: 150, maxBytes: 40 })).rejects.toThrow('E_SITE_TIMEOUT');
	});

	test('a body past the byte cap is cut there and the connection is closed on the server', async () => {
		let closed!: () => void;
		const serverSawClose = new Promise<string>((resolve) => {
			closed = () => resolve('closed');
		});
		const port = await stub((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			const timer = setInterval(() => res.write('a'.repeat(400)), 5);
			res.on('close', () => {
				clearInterval(timer);
				closed();
			});
		});
		const get = createGet(http.request, port);
		const reply = await get(TARGET, { timeoutMs: 3000, maxBytes: 1000 });
		expect(reply.status).toBe(200);
		expect(reply.contentType).toBe('text/html');
		expect(reply.body).toBe('a'.repeat(1000));
		const wait = new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 2000));
		await expect(Promise.race([serverSawClose, wait])).resolves.toBe('closed');
	});

	test('a redirect is reported, with its location, not followed', async () => {
		let hits = 0;
		const port = await stub((_req, res) => {
			hits++;
			res.writeHead(302, { location: 'https://www.site.test/' });
			res.end();
		});
		const reply = await createGet(http.request, port)(TARGET, { timeoutMs: 3000, maxBytes: 1000 });
		expect(reply.status).toBe(302);
		expect(reply.location).toBe('https://www.site.test/');
		expect(hits).toBe(1);
	});
});

/** A request function that records its options and never answers (it only fails when its abort signal fires). */
function spyRequest() {
	const calls: Record<string, unknown>[] = [];
	const request = ((options: Record<string, unknown> & { signal?: AbortSignal }) => {
		calls.push(options);
		const req = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
		req.end = () => {};
		req.destroy = () => {};
		options.signal?.addEventListener('abort', () => req.emit('error', new Error('E_TEST_ABORT')));
		return req;
	}) as unknown as RequestFn;
	return { request, calls };
}

describe('the production wiring', () => {
	test('connects to exactly the checked address, names the host for TLS, and keeps certificate checks', async () => {
		const { request, calls } = spyRequest();
		const get = createGet(request);
		await expect(
			get(
				{ ...TARGET, address: PUBLIC_IP, host: 'site.test', path: '/x' },
				{ timeoutMs: 20, maxBytes: 10 }
			)
		).rejects.toThrow('E_SITE_TIMEOUT');
		expect(calls).toHaveLength(1);
		const options = calls[0] ?? {};
		expect(options).toMatchObject({
			host: PUBLIC_IP,
			family: 4,
			port: 443,
			path: '/x',
			servername: 'site.test',
			headers: { Host: 'site.test', 'User-Agent': USER_AGENT }
		});
		// A custom lookup would be a second DNS resolution, and false would switch certificate checks off.
		expect(options).not.toHaveProperty('lookup');
		expect(options.rejectUnauthorized).not.toBe(false);
	});

	test('an http target is refused before any socket is opened', async () => {
		const { request, calls } = spyRequest();
		await expect(
			createGet(request)({ ...TARGET, protocol: 'http:' }, { timeoutMs: 20, maxBytes: 10 })
		).rejects.toThrow('E_SITE_NOT_HTTPS');
		expect(calls).toEqual([]);
	});

	test('private addresses are refused by the real address check, with no connection made', async () => {
		const deps = createSiteDeps();
		for (const host of ['127.0.0.1', 'localhost']) {
			const resolved = await deps.lookup(host);
			expect(resolved.length, host).toBeGreaterThan(0);
			expect(
				resolved.filter((r) => deps.isAllowedAddress(r.address)),
				host
			).toEqual([]);
			await expect(createSiteCheck()('https://' + host + '/'), host).resolves.toBe(false);
		}
	});
});
