/**
 * Which organizations get a company website and a LinkedIn page. A site is shown only when the email's domain
 * belongs to that one organization, its name matches the domain, and one guarded GET finds a live page; a LinkedIn
 * page comes from Wikidata alone and is never fetched. Nothing here touches the network: the Wikidata lookup and
 * the site check are injected.
 */

import { isGovernmentHost } from '../../src/lib/sources/government-host.ts';
import { validateListing } from '../../src/lib/skillbridge-finder/contract/validate.ts';
import type { Listing } from '../../src/lib/skillbridge-finder/contract/listing.ts';
import type { CleanListing, LinksOutput, OrgLinks } from './types.ts';

export type WikidataFacts = { site?: string; linkedinId?: string };
export type LinkDeps = {
	wikidata(names: string[]): Promise<Map<string, WikidataFacts>>;
	siteCheck(url: string): Promise<boolean>;
};

/**
 * Free and ISP mail: an address there says nothing about the sender's company. The social platforms (LinkedIn and
 * its lnkd.in short links, Facebook, Reddit) are listed too, though they are no mail hosts: this pipeline must
 * never make a request to them, and a domain here (or a subdomain of it) is never requested.
 */
const BLOCKED_DOMAINS: readonly string[] = [
	'gmail.com',
	'googlemail.com',
	'yahoo.com',
	'ymail.com',
	'outlook.com',
	'hotmail.com',
	'live.com',
	'msn.com',
	'aol.com',
	'icloud.com',
	'me.com',
	'mac.com',
	'protonmail.com',
	'proton.me',
	'gmx.com',
	'gmx.net',
	'mail.com',
	'zoho.com',
	'yandex.com',
	'comcast.net',
	'verizon.net',
	'att.net',
	'sbcglobal.net',
	'bellsouth.net',
	'cox.net',
	'charter.net',
	'earthlink.net',
	'juno.com',
	'netzero.net',
	'frontier.com',
	'windstream.net',
	'centurylink.net',
	'optonline.net',
	'rr.com',
	'roadrunner.com',
	'spectrum.net',
	'linkedin.com',
	'lnkd.in',
	'facebook.com',
	'fb.com',
	'reddit.com',
	'redd.it'
];

/** Words dropped from the end of a name before it is compared with a domain, once their dots and commas are gone. */
const LEGAL_WORDS: ReadonlySet<string> = new Set([
	'inc',
	'llc',
	'corp',
	'corporation',
	'co',
	'company',
	'ltd',
	'limited',
	'lp',
	'llp',
	'pllc',
	'pc',
	'plc'
]);
const ACRONYM_SKIPPED: ReadonlySet<string> = new Set(['of', 'and', 'the', '&']);

const LINKEDIN_COMPANY = 'https://www.linkedin.com/company/';
const LINKEDIN_ID_RE = /^[A-Za-z0-9_%-]+$/;
const WHITESPACE_RE = /\s+/;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MAX_DOMAIN_LENGTH = 253;

/** A minimal valid listing: the contract validates a whole listing, and only the link fields are of interest. */
const PROBE: Listing = {
	i: 1,
	o: 1,
	n: 'Probe',
	p: 'Probe',
	m: 1,
	b: [],
	ind: [],
	dib: false,
	dc: '2026-01-01',
	fl: '2026-01-01'
};

/** The lowercased domain of an address, or null when it is not a plain dotted host name. */
export function emailDomain(email: string): string | null {
	const at = email.lastIndexOf('@');
	if (at < 1) return null;
	const domain = email.slice(at + 1).toLowerCase();
	if (domain.length > MAX_DOMAIN_LENGTH) return null;
	const labels = domain.split('.');
	if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL_RE.test(label))) return null;
	return domain;
}

export function isBlockedMailDomain(domain: string): boolean {
	const d = domain.toLowerCase();
	if (isGovernmentHost('https://' + d + '/')) return true;
	return BLOCKED_DOMAINS.some((blocked) => d === blocked || d.endsWith('.' + blocked));
}

/** The label left of the last dot: `mail.example.com` gives `example`. */
export function domainLabel(domain: string): string {
	const labels = domain.split('.');
	return labels.length < 2 ? domain : (labels[labels.length - 2] ?? '');
}

/** A word without its dots and commas, so `L.L.C.` and `Inc.,` read as `llc` and `inc`. */
const bareWord = (word: string): string => word.split('.').join('').split(',').join('');

/** The words of a name with trailing legal words removed; the last remaining word is never removed. */
function nameWords(name: string): string[] {
	const words = name
		.normalize('NFKC')
		.toLowerCase()
		.split(WHITESPACE_RE)
		.filter((word) => word.length > 0);
	while (words.length > 1 && LEGAL_WORDS.has(bareWord(words[words.length - 1] ?? ''))) words.pop();
	return words;
}

const isAsciiAlnum = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');

/** The name as it would appear in a domain: no legal suffix, only a-z and 0-9. */
export function squashName(name: string): string {
	return [...nameWords(name).join('')].filter(isAsciiAlnum).join('');
}

/** The first letters of the name's words, skipping of/and/the/&; empty unless there are at least two. */
export function acronym(name: string): string {
	const letters = nameWords(name)
		.filter((word) => !ACRONYM_SKIPPED.has(word))
		.map((word) => [...word].find(isAsciiAlnum) ?? '')
		.filter((letter) => letter !== '');
	return letters.length >= 2 ? letters.join('') : '';
}

const withoutWww = (host: string): string => (host.startsWith('www.') ? host.slice(4) : host);

function siteHost(site: string | undefined): string | null {
	if (site === undefined) return null;
	try {
		return withoutWww(new URL(site).hostname.toLowerCase());
	} catch {
		return null;
	}
}

/** The written matcher: the name, its acronym, or Wikidata's official website points at this domain. */
export function nameMatches(name: string, domain: string, wikidataSite?: string): boolean {
	const label = domainLabel(domain);
	const squashed = squashName(name);
	if (squashed !== '' && squashed === label) return true;
	const short = acronym(name);
	if (short !== '' && short === label) return true;
	const host = siteHost(wikidataSite);
	return host !== null && host === withoutWww(domain);
}

/** Whether the contract accepts `value` as the listing's `field` (and so may be shown on a card). */
function passesContract(field: 'w' | 'li', value: string): boolean {
	return !validateListing({ ...PROBE, [field]: value }).some((error) => error.field === field);
}

type Org = { id: number; name: string; domain: string | null };

/** One organization per id, described by its lowest-id listing; plus which organizations use each email domain. */
function groupOrgs(listings: readonly CleanListing[]): {
	orgs: Org[];
	domainUsers: Map<string, Set<number>>;
} {
	const first = new Map<number, CleanListing>();
	const domainUsers = new Map<string, Set<number>>();
	for (const l of listings) {
		const seen = first.get(l.o);
		if (seen === undefined || l.i < seen.i) first.set(l.o, l);
		const domain = l.e === undefined ? null : emailDomain(l.e);
		if (domain === null) continue;
		const users = domainUsers.get(domain) ?? new Set<number>();
		users.add(l.o);
		domainUsers.set(domain, users);
	}
	const orgs = [...first.entries()]
		.sort(([a], [b]) => a - b)
		.map(([id, l]): Org => ({
			id,
			name: l.n,
			domain: l.e === undefined ? null : emailDomain(l.e)
		}));
	return { orgs, domainUsers };
}

export async function runLinks(
	listings: readonly CleanListing[],
	pinned: readonly [number, string][],
	deps: LinkDeps
): Promise<LinksOutput> {
	const { orgs, domainUsers } = groupOrgs(listings);
	const facts = await deps.wikidata([...new Set(orgs.map((org) => org.name))]);
	const pins = new Map(pinned.filter(([, url]) => passesContract('w', url)));
	const byOrg: [number, OrgLinks][] = [];
	let requests = 0;

	for (const org of orgs) {
		const links: OrgLinks = {};
		const found = facts.get(org.name);

		const domain = org.domain;
		if (
			domain !== null &&
			!isBlockedMailDomain(domain) &&
			(domainUsers.get(domain)?.size ?? 0) === 1
		) {
			const pin = pins.get(org.id);
			if (pin !== undefined) {
				links.w = pin;
			} else if (nameMatches(org.name, domain, found?.site)) {
				const url = 'https://' + domain + '/';
				requests++;
				if ((await deps.siteCheck(url)) && passesContract('w', url)) {
					links.w = url;
					pins.set(org.id, url);
				}
			}
		}

		const id = found?.linkedinId;
		if (id !== undefined && LINKEDIN_ID_RE.test(id) && passesContract('li', LINKEDIN_COMPANY + id))
			links.li = LINKEDIN_COMPANY + id;

		if (links.w !== undefined || links.li !== undefined) byOrg.push([org.id, links]);
	}

	return {
		byOrg,
		pinned: [...pins.entries()].sort(([a], [b]) => a - b),
		requests
	};
}
