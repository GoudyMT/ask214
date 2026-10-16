import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupMessage } from './copy';
import { BACKUP_ID_ALPHABET, makeBackupId, makeBackupNames, parseBackupLabel } from './naming';

const ID = 'K7Q2';
const NOON_ISH = new Date(2026, 9, 15, 14, 32, 5);
const NEAR_MIDNIGHT = new Date(2026, 9, 15, 23, 30, 0);

// Fills a four-byte draw with the given bytes and refuses any other kind of draw.
function scriptBytes(bytes: readonly number[]) {
	return vi
		.spyOn(crypto, 'getRandomValues')
		.mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
			if (!(array instanceof Uint8Array) || array.length !== 4) throw new Error('not 4 bytes');
			bytes.forEach((value, i) => {
				array[i] = value;
			});
			return array;
		});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('makeBackupNames', () => {
	it('the file name matches the ask214-backup-<date>-<id>.json shape', () => {
		const { fileName } = makeBackupNames(NOON_ISH, ID);
		expect(fileName).toMatch(/^ask214-backup-\d{4}-\d{2}-\d{2}-[A-Z2-7]{4}\.json$/);
		expect(fileName).toBe('ask214-backup-2026-10-15-K7Q2.json');
	});

	it("the label is 'Ask 214 backup <date> <id>' with the same date and id as the file name", () => {
		const { fileName, label } = makeBackupNames(NOON_ISH, ID);
		expect(label).toBe('Ask 214 backup 2026-10-15 K7Q2');
		const parts = /^ask214-backup-(\d{4}-\d{2}-\d{2})-([A-Z2-7]{4})\.json$/.exec(fileName);
		expect(label).toBe('Ask 214 backup ' + parts?.[1] + ' ' + parts?.[2]);
	});

	it('no time of day appears in the name or the label', () => {
		const { fileName, label } = makeBackupNames(NOON_ISH, ID);
		const afterDate = (text: string) =>
			text.slice(text.indexOf('2026-10-15') + '2026-10-15'.length);
		expect(afterDate(fileName)).toBe('-K7Q2.json');
		expect(afterDate(label)).toBe(' K7Q2');
		// The prefixes hold the digits 214 on their own, so only the part after the date can be checked for 14 and 32.
		expect(afterDate(fileName) + afterDate(label)).not.toMatch(/14|32|:/);
	});

	it('the date is the local date near midnight', () => {
		// Guards the premise: in the test time zone the UTC date is already the next day.
		expect(NEAR_MIDNIGHT.toISOString().slice(0, 10)).toBe('2026-10-16');
		const { fileName, label } = makeBackupNames(NEAR_MIDNIGHT, ID);
		expect(fileName).toBe('ask214-backup-2026-10-15-K7Q2.json');
		expect(label).toBe('Ask 214 backup 2026-10-15 K7Q2');
	});

	it('makeBackupNames refuses a malformed id', () => {
		const bad = [
			'',
			'K7Q',
			'K7Q2X',
			'k7q2',
			'K7Q0',
			'K7Q1',
			'K7Q8',
			'K7Q9',
			'K7Q2\n',
			' K7Q',
			'K7-2'
		];
		for (const id of bad) {
			expect(() => makeBackupNames(NOON_ISH, id), JSON.stringify(id)).toThrow('E_INTERNAL');
		}
	});

	it('two sessions with different random bytes get different names', () => {
		scriptBytes([0, 1, 2, 3]);
		const first = makeBackupNames(NOON_ISH, makeBackupId());
		vi.restoreAllMocks();
		scriptBytes([4, 5, 6, 7]);
		const second = makeBackupNames(NOON_ISH, makeBackupId());
		expect(first.fileName).toBe('ask214-backup-2026-10-15-ABCD.json');
		expect(second.fileName).toBe('ask214-backup-2026-10-15-EFGH.json');
		expect(second.label).not.toBe(first.label);
	});

	it('every alphabet character is accepted in every position and fits the label shape copy.ts shows', () => {
		expect(BACKUP_ID_ALPHABET).toHaveLength(32);
		for (const symbol of BACKUP_ID_ALPHABET) {
			const id = symbol.repeat(4);
			const { label } = makeBackupNames(NOON_ISH, id);
			const text = backupMessage('E_WRONG_PASSPHRASE', { path: 'restore', label });
			expect(text, label).toContain(label);
		}
	});
});

describe('makeBackupId', () => {
	it('uses the base32 alphabet of RFC 4648', () => {
		expect(BACKUP_ID_ALPHABET).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
	});

	it('makeBackupId maps every byte value to the alphabet uniformly', () => {
		const counts = [0, 1, 2, 3].map(() => new Map<string, number>());
		for (let value = 0; value < 256; value++) {
			// The four positions see the 256 values in a different rotation, so each position gets all of them.
			scriptBytes([value, (value + 64) % 256, (value + 128) % 256, (value + 192) % 256]);
			const id = makeBackupId();
			vi.restoreAllMocks();
			expect(id).toMatch(/^[A-Z2-7]{4}$/);
			[...id].forEach((symbol, position) => {
				const map = counts[position];
				map?.set(symbol, (map.get(symbol) ?? 0) + 1);
			});
		}
		for (const map of counts) {
			expect([...map.keys()].sort().join('')).toBe([...BACKUP_ID_ALPHABET].sort().join(''));
			expect([...map.values()].every((count) => count === 8)).toBe(true);
		}
	});

	it('asks for exactly four random bytes', () => {
		const spy = scriptBytes([0, 0, 0, 0]);
		makeBackupId();
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
		expect((spy.mock.calls[0]?.[0] as Uint8Array).length).toBe(4);
	});

	it('makeBackupId takes no parameters', () => {
		expect(makeBackupId.length).toBe(0);
	});

	it('gives an id of the right shape with the real random source', () => {
		expect(makeBackupId()).toMatch(/^[A-Z2-7]{4}$/);
	});
});

describe('parseBackupLabel', () => {
	it.each([
		['ask214-backup-2026-10-15-K7Q2.json', 'Ask 214 backup 2026-10-15 K7Q2'],
		['ask214-backup-2027-01-02-AAAA.json', 'Ask 214 backup 2027-01-02 AAAA'],
		['ask214-backup-2026-10-15-7765.json', 'Ask 214 backup 2026-10-15 7765'],
		['ask214-backup-2026-10-15-K7Q2 (1).json', null],
		['ask214-backup-2026-10-15-K7Q2(1).json', null],
		['ask214-backup-2026-10-15-K7Q2.json (1)', null],
		['ask214-backup-2026-10-15-K7Q2.JSON', null],
		['ASK214-BACKUP-2026-10-15-K7Q2.json', null],
		['ask214-backup-2026-10-15-k7q2.json', null],
		['ask214-backup-2026-10-15-K7Q0.json', null],
		['ask214-backup-2026-10-15-K7Q1.json', null],
		['ask214-backup-2026-10-15-K7Q8.json', null],
		['ask214-backup-2026-10-15-K7Q9.json', null],
		['ask214-backup-2026-10-15-K7Q2.json.json', null],
		['ask214-backup-2026-10-15-K7Q2.json\n', null],
		['ask214-backup-2026-10-15-K7Q.json', null],
		['ask214-backup-2026-10-15-K7Q2X.json', null],
		['ask214-backup-2026-10-15-1432-K7Q2.json', null],
		['ask214-backup-2026-10-15-14-32-K7Q2.json', null],
		['ask214-backup-26-10-15-K7Q2.json', null],
		['my ask214-backup-2026-10-15-K7Q2.json', null],
		['downloads/ask214-backup-2026-10-15-K7Q2.json', null],
		['C:\\downloads\\ask214-backup-2026-10-15-K7Q2.json', null],
		['', null]
	])('parseBackupLabel reads our names and returns null for a renamed file: %j', (name, want) => {
		expect(parseBackupLabel(name)).toBe(want);
	});

	it('gives back the label that makeBackupNames made', () => {
		const { fileName, label } = makeBackupNames(NOON_ISH, ID);
		expect(parseBackupLabel(fileName)).toBe(label);
	});
});
