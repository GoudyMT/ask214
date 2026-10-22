import { describe, it, expect } from 'vitest';
import type { ChangesFile, IdsFile } from '../contract/listing';
import { resolveId, savedStatus } from './saved-status';

const idsFile = (ids: number[], aliases: [number, number][] = []): IdsFile => ({
	v: 1,
	pullDate: '2026-10-21',
	ids: ids.map((i) => [i, '2026-10-01']),
	aliases
});
const week = (pullDate: string, removed: number[]): ChangesFile['weeks'][number] => ({
	pullDate,
	added: [],
	removed,
	newOrgs: []
});

describe('resolveId', () => {
	it('returns an id that was not merged as it is', () => {
		expect(resolveId(5, [[1, 2]])).toBe(5);
	});

	it('follows merged ids through a chain to the id they ended in', () => {
		expect(
			resolveId(1, [
				[1, 2],
				[2, 3],
				[3, 4]
			])
		).toBe(4);
	});

	// A hostile or damaged file can make two ids point at each other; the walk must end, not hang the page.
	it('stops on a cycle', () => {
		const cycle: [number, number][] = [
			[1, 2],
			[2, 3],
			[3, 1]
		];
		expect(resolveId(1, cycle)).toBe(3);
		expect(resolveId(2, [[2, 2]])).toBe(2);
		expect(
			resolveId(1, [
				[1, 2],
				[2, 1]
			])
		).toBe(2);
	});

	it('stops after 50 steps on a very long chain', () => {
		const chain: [number, number][] = Array.from({ length: 200 }, (_, n) => [n, n + 1]);
		expect(resolveId(0, chain)).toBe(50);
	});
});

describe('savedStatus', () => {
	it('is listed while the id is in the current listings', () => {
		expect(savedStatus(10, idsFile([10, 11]))).toEqual({ kind: 'listed', id: 10 });
	});

	it('is listed under the id the saved one merged into', () => {
		const ids = idsFile(
			[30],
			[
				[10, 20],
				[20, 30]
			]
		);
		expect(savedStatus(10, ids)).toEqual({ kind: 'listed', id: 30 });
	});

	// The saved card says when the program left, from the week that removed it; the date is the data's, not a guess.
	it('is missing since the week whose removed list names the program', () => {
		const changes: ChangesFile = {
			v: 1,
			weeks: [week('2026-10-14', [99]), week('2026-10-21', [10])]
		};
		expect(savedStatus(10, idsFile([11]), changes)).toEqual({
			kind: 'missing',
			since: '2026-10-21'
		});
	});

	it('reads the removal under the id the saved one merged into', () => {
		const changes: ChangesFile = { v: 1, weeks: [week('2026-10-14', [20])] };
		expect(savedStatus(10, idsFile([11], [[10, 20]]), changes)).toEqual({
			kind: 'missing',
			since: '2026-10-14'
		});
	});

	it('names the latest removal when two weeks both name it', () => {
		const changes: ChangesFile = {
			v: 1,
			weeks: [week('2026-10-14', [10]), week('2026-10-21', [10])]
		};
		expect(savedStatus(10, idsFile([11]), changes)).toEqual({
			kind: 'missing',
			since: '2026-10-21'
		});
	});

	// A program that left more than two weeks ago is in no published week; inventing a date would be false.
	it('is missing with no date when no week names it, or there is no changes file', () => {
		const changes: ChangesFile = { v: 1, weeks: [week('2026-10-21', [99])] };
		expect(savedStatus(10, idsFile([11]), changes)).toEqual({ kind: 'missing' });
		expect(savedStatus(10, idsFile([11]))).toEqual({ kind: 'missing' });
		expect('since' in savedStatus(10, idsFile([11]))).toBe(false);
	});

	it('is listed again when the program comes back', () => {
		const changes: ChangesFile = { v: 1, weeks: [week('2026-10-14', [10])] };
		expect(savedStatus(10, idsFile([11]), changes).kind).toBe('missing');
		expect(savedStatus(10, idsFile([10, 11]), changes)).toEqual({ kind: 'listed', id: 10 });
	});

	it('ends on an alias cycle and reports missing', () => {
		const ids = idsFile(
			[99],
			[
				[1, 2],
				[2, 1]
			]
		);
		expect(savedStatus(1, ids).kind).toBe('missing');
	});
});
