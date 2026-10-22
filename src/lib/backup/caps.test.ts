import { describe, it, expect } from 'vitest';
import { encodeEaos, parseEaosAtRead } from '../profile/eaos';
import {
	BRANCHES,
	CAPS,
	DURATIONS,
	INDUSTRIES,
	KINDS,
	type Listing
} from '../skillbridge-finder/contract/listing';
import { STATE_CODES } from '../skillbridge-finder/contract/places';
import { MAX_COMPARE, MAX_SAVED, type FinderRecord } from '../skillbridge-finder/state/types';
import {
	MAX_CIPHERTEXT_BYTES,
	MAX_DATA_B64_CHARS,
	ENVELOPE_FIXED_BYTES,
	FILE_SLACK_BYTES,
	MAX_FILE_BYTES
} from './caps';
import { serializeEnvelope } from './envelope-json';
import { buildExportInner } from './export-inner';

function b64OfZeros(bytes: number): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

describe('backup caps', () => {
	it('derived numbers', () => {
		expect(MAX_CIPHERTEXT_BYTES).toBe(6_291_472);
		expect(MAX_DATA_B64_CHARS).toBe(8_388_632);
		expect(FILE_SLACK_BYTES).toBe(4096);

		// The real serializer with empty data and base64 of the real salt, iv and check lengths.
		const empty = serializeEnvelope({
			salt: b64OfZeros(16),
			iv: b64OfZeros(12),
			check: b64OfZeros(32),
			data: ''
		});
		expect(ENVELOPE_FIXED_BYTES).toBe(new TextEncoder().encode(empty).length);
		// Pinned: format v1 fixes the layout, so this number moves only with a format change, and then the file limit
		// must be re-derived on purpose.
		expect(ENVELOPE_FIXED_BYTES).toBe(243);

		expect(MAX_FILE_BYTES).toBe(ENVELOPE_FIXED_BYTES + MAX_DATA_B64_CHARS + FILE_SLACK_BYTES);
		expect(MAX_FILE_BYTES).toBe(8_392_971);
	});
});

// The finder's share of a backup. The most a person can keep (200 saved programs) with every field of every program at
// its published cap, in the widest characters the contract allows (three bytes each), must leave room in the 6 MiB
// plaintext for the profile, the timeline's notes and the calendar.
describe('the finder record in a backup', () => {
	const FINDER_SHARE_BYTES = 2.5 * 1024 * 1024;
	// A CJK ideograph: three bytes in UTF-8, stable under NFKC, nothing invisible.
	const WIDE = String.fromCharCode(0x4e2d);
	const wide = (chars: number) => WIDE.repeat(chars);

	function worstListing(i: number): Listing {
		return {
			i,
			o: Number.MAX_SAFE_INTEGER,
			n: wide(CAPS.organization),
			p: wide(CAPS.program),
			k: KINDS[0],
			c: wide(CAPS.city),
			s: 'WY',
			ls: [...STATE_CODES],
			z: '21046',
			la: -89.123456789012,
			lo: -179.123456789012,
			d: DURATIONS[DURATIONS.length - 1] as Listing['d'],
			m: 3,
			b: [...BRANCHES],
			// A role is a short name of one to six words; one 80-character word is the longest it can be.
			r: Array.from({ length: CAPS.roles }, () => wide(CAPS.roleItem)),
			ind: [...INDUSTRIES],
			oc: Array.from({ length: CAPS.codes }, (_, n) => `A${String(n).padStart(5, '0')}`),
			dib: true,
			dc: '2026-10-21',
			fl: '2026-10-21',
			// An email or a form link, never both: the form link is the longer.
			u: 'https://example.com/' + wide(CAPS.url - 'https://example.com/'.length),
			w:
				'https://' +
				['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(63)].join('.') +
				'.com/',
			li:
				'https://www.linkedin.com/company/' +
				'a'.repeat(CAPS.url - 'https://www.linkedin.com/company/'.length),
			inst: wide(CAPS.installation)
		};
	}

	function worstRecord(): FinderRecord {
		return {
			schemaVersion: 1,
			finderSetup: {
				place: { kind: 'zip', zip: '21046' },
				radius: 'any',
				territories: true,
				overseas: true
			},
			finderFilters: {
				industries: [...INDUSTRIES],
				branches: [...BRANCHES],
				durations: [...DURATIONS],
				kinds: [...KINDS],
				delivery: [1, 2, 3]
			},
			finderSaved: Array.from({ length: MAX_SAVED }, (_, n) => ({
				id: n + 1,
				savedOn: '2026-10-21',
				facts: worstListing(n + 1)
			})),
			finderCompare: Array.from({ length: MAX_COMPARE }, (_, n) => n + 1)
		};
	}

	it('200 saved programs at every cap export, validate, and stay inside the finder share', () => {
		const built = buildExportInner(
			{
				ok: true,
				profile: {
					schemaVersion: 1,
					generation: 1,
					lastSeenAt: 0,
					setupIntent: 'completed',
					setupIntentChangedAt: 0,
					eaos: encodeEaos(parseEaosAtRead('2027-06-30'))
				},
				timeline: null,
				calendar: null,
				finder: worstRecord(),
				gens: { profile: 1, timeline: 0, calendar: 0, finder: 1 }
			},
			0
		);
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		const stores = (JSON.parse(new TextDecoder().decode(built.bytes)) as { stores: object }).stores;
		const finderBytes = new TextEncoder().encode(
			JSON.stringify((stores as Record<string, unknown>)['skillbridge-finder'])
		).length;
		expect(finderBytes).toBeLessThan(FINDER_SHARE_BYTES);
		// The fixture really is near the worst case: a ceiling this far above it would prove nothing.
		expect(finderBytes).toBeGreaterThan(FINDER_SHARE_BYTES * 0.5);
	});
});
