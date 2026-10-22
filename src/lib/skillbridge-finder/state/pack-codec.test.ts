import { describe, it, expect } from 'vitest';
import {
	decodeSeen,
	encodeSeen,
	FinderPackError,
	MAX_SEEN,
	type FinderSeenRow
} from './pack-codec';

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function expectRefused(bytes: Uint8Array) {
	let caught: unknown;
	try {
		decodeSeen(bytes);
	} catch (e) {
		caught = e;
	}
	expect(caught).toBeInstanceOf(FinderPackError);
	expect((caught as FinderPackError).message).toBe('E_FINDER_PACK_BAD_SEEN');
}

describe('seen row codec', () => {
	it('round-trips a row with and without a last-seen pull', () => {
		const full: FinderSeenRow = {
			finderSeen: [1001, 1003, 1005],
			finderLastSeenPull: '2026-10-21'
		};
		expect(decodeSeen(encodeSeen(full))).toEqual(full);
		const bare: FinderSeenRow = { finderSeen: [] };
		expect(decodeSeen(encodeSeen(bare))).toEqual(bare);
	});

	it('keeps a row at exactly the cap', () => {
		const ids = Array.from({ length: MAX_SEEN }, (_, n) => n + 1);
		expect(decodeSeen(bytesOf({ finderSeen: ids })).finderSeen).toHaveLength(MAX_SEEN);
	});

	// A newer release may add a key; this one validates the two it knows and carries the rest forward unchanged.
	it('carries a key it does not know through a decode and an encode', () => {
		const row = decodeSeen(bytesOf({ finderSeen: [7], future: 1 }));
		expect(JSON.parse(new TextDecoder().decode(encodeSeen(row)))).toEqual({
			finderSeen: [7],
			future: 1
		});
	});

	describe('refuses what it cannot trust, with a static code', () => {
		const bad: [string, unknown][] = [
			['bytes that are not JSON', undefined],
			['a row that is not an object', [1, 2]],
			['no list', {}],
			['a list that is not a list', { finderSeen: '1,2' }],
			['an id that is not an integer', { finderSeen: [1.5] }],
			['an id of zero', { finderSeen: [0] }],
			['an id given as text', { finderSeen: ['7'] }],
			['an id past the safe integers', { finderSeen: [Number.MAX_SAFE_INTEGER + 2] }],
			['the same id twice', { finderSeen: [4, 4] }],
			['more than the cap', { finderSeen: Array.from({ length: MAX_SEEN + 1 }, (_, n) => n + 1) }],
			// One bad date: what makes a date good is the contract's rule, tested there; this proves the call is made.
			['a date that is not a day', { finderSeen: [], finderLastSeenPull: '2026-02-30' }]
		];
		it.each(bad)('%s', (_name, value) => {
			expectRefused(value === undefined ? new Uint8Array([0xff, 0xfe]) : bytesOf(value));
		});
	});

	// A row that is written but cannot be read back would lose the person's "new" marks, so the write holds the same line.
	it('refuses to encode a row it would refuse to read', () => {
		expect(() => encodeSeen({ finderSeen: [3, 3] })).toThrow('E_FINDER_PACK_BAD_SEEN');
		expect(() => encodeSeen({ finderSeen: [], finderLastSeenPull: 'soon' })).toThrow(
			'E_FINDER_PACK_BAD_SEEN'
		);
	});
});
