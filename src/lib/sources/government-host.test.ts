import { describe, expect, it } from 'vitest';
import { isGovernmentHost } from './government-host';

// This is a security boundary with two consumers - the sources registry at build time and the online
// retrieval response at runtime - so it gets its own tests rather than relying on either consumer's.
describe('isGovernmentHost', () => {
	it('accepts the restricted TLDs no lookalike can register', () => {
		expect(isGovernmentHost('https://www.va.gov/health-care')).toBe(true);
		expect(isGovernmentHost('https://tapevents.mil/resources/documents')).toBe(true);
		expect(isGovernmentHost('https://benefits.va.gov/gibill/')).toBe(true);
	});

	// The whole reason a scheme check is not enough. In each of these the government label is a LABEL inside
	// a hostname the attacker controls, and every one of them passes `/^https:\/\//`.
	it('rejects a host that merely CONTAINS a government label', () => {
		expect(isGovernmentHost('https://tapevents.mil.evil.example/x.pdf')).toBe(false);
		expect(isGovernmentHost('https://va.gov.attacker.io/claim')).toBe(false);
		expect(isGovernmentHost('https://notva.gov.co/benefits')).toBe(false);
		expect(isGovernmentHost('https://evil.example/va.gov')).toBe(false);
		expect(isGovernmentHost('https://evil.example/?next=va.gov')).toBe(false);
	});

	// A bare TLD is a valid hostname and is accepted; "milk.com" is not, and the endsWith check must not be
	// fooled by a suffix that merely ends in the same letters.
	it('matches on the label boundary, not on a substring of it', () => {
		expect(isGovernmentHost('https://gov/')).toBe(true);
		expect(isGovernmentHost('https://mil/')).toBe(true);
		expect(isGovernmentHost('https://milk.com/')).toBe(false);
		expect(isGovernmentHost('https://ungov.com/')).toBe(false);
	});

	it('is case-insensitive on the host', () => {
		expect(isGovernmentHost('https://WWW.VA.GOV/health')).toBe(true);
		expect(isGovernmentHost('https://TapEvents.MIL/x')).toBe(true);
	});

	// It returns a verdict rather than throwing, because both call sites use it as a filter over untrusted
	// input - one over a YAML registry, one over a server response body.
	it('returns false rather than throwing on anything unparseable', () => {
		expect(isGovernmentHost('not a url')).toBe(false);
		expect(isGovernmentHost('')).toBe(false);
		expect(isGovernmentHost('//va.gov/x')).toBe(false);
	});

	// It answers ONE question. The scheme is a separate gate at both call sites, and folding them together
	// here would let a caller drop one by accident.
	it('answers only the host question, leaving the scheme to its own gate', () => {
		expect(isGovernmentHost('http://www.va.gov/health')).toBe(true);
		expect(isGovernmentHost('javascript:alert(1)//va.gov')).toBe(false);
	});
});
