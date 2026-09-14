/**
 * Whether a url points at a genuine US-Government host.
 *
 * `https://` alone is not the boundary this project has. It ships public US-Government work only
 * (17 USC 105), and these urls become citation hrefs on a surface whose audience is targeted by benefits
 * scams - so neither a registry entry nor a server response may put an arbitrary host in front of a veteran.
 *
 * A scheme check passes `https://tapevents.mil.evil.example/x.pdf`: the ".mil" there is a LABEL, not the
 * host. Parsing and testing the HOSTNAME is what closes that, and `.gov` / `.mil` are restricted TLDs no
 * lookalike can register.
 *
 * Shared deliberately. This rule is enforced in two places - the sources registry at build time and the
 * online retrieval response at runtime - and they were allowed to drift apart once, with the runtime side
 * checking only the scheme. One definition means a hardening applied to either is applied to both.
 *
 * @param url The candidate url, from any untrusted or semi-trusted origin.
 * @returns true only when the url parses AND its hostname is, or ends in, a .gov or .mil label.
 */
export function isGovernmentHost(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return host === 'gov' || host === 'mil' || host.endsWith('.gov') || host.endsWith('.mil');
}
