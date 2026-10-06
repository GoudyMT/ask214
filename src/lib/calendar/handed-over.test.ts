import { describe, it, expect } from 'vitest';
import { mergeHandedOver, staleEvents, acknowledge } from './handed-over';
import type { DesiredEvent, HandedOverEvent } from './types';

const TODAY = '2026-10-04';
const ev = (taskId: string, isoDate: string, title = `Last day: ${taskId}`): DesiredEvent => ({
	taskId,
	moment: 'last',
	title,
	isoDate,
	alarmDays: []
});
const held = (e: DesiredEvent, addedOn = '2026-10-03'): HandedOverEvent => ({
	taskId: e.taskId,
	moment: e.moment,
	title: e.title,
	isoDate: e.isoDate,
	addedOn
});

describe('mergeHandedOver', () => {
	it('records each event handed over, with the day it was added', () => {
		expect(mergeHandedOver(undefined, [ev('a', '2026-11-01')], TODAY, TODAY)).toEqual([
			held(ev('a', '2026-11-01'), TODAY)
		]);
	});

	it('keeps an older version a calendar app may still hold', () => {
		const out = mergeHandedOver(
			[held(ev('a', '2027-01-30'))],
			[ev('a', '2026-10-31')],
			TODAY,
			TODAY
		);
		expect(out.map((e) => e.isoDate)).toEqual(['2027-01-30', '2026-10-31']);
	});

	it('does not record the same event twice', () => {
		const out = mergeHandedOver(
			[held(ev('a', '2026-11-01'))],
			[ev('a', '2026-11-01')],
			TODAY,
			TODAY
		);
		expect(out).toHaveLength(1);
	});

	it('drops an entry dated before today', () => {
		expect(mergeHandedOver([held(ev('a', '2026-10-01'))], [], TODAY, TODAY)).toEqual([]);
	});

	it('keeps an entry dated today', () => {
		expect(mergeHandedOver([held(ev('a', TODAY))], [], TODAY, TODAY)).toHaveLength(1);
	});
});

describe('staleEvents', () => {
	it('lists nothing when there is no record yet', () => {
		expect(staleEvents(undefined, [], TODAY)).toEqual([]);
	});

	it('lists an event gone from the file, or moved, or retitled - by its old title and date', () => {
		const record = [
			held(ev('done', '2026-12-01')),
			held(ev('moved', '2027-01-30')),
			held(ev('renamed', '2026-12-15', 'Aim for: old'))
		];
		const desired = [ev('moved', '2026-10-31'), ev('renamed', '2026-12-15', 'Aim for: new')];
		expect(staleEvents(record, desired, TODAY).map((e) => e.taskId)).toEqual([
			'done',
			'moved',
			'renamed'
		]);
	});

	it('does not list an event still in the file, or one dated today or earlier', () => {
		const record = [held(ev('same', '2026-12-01')), held(ev('today', TODAY))];
		expect(staleEvents(record, [ev('same', '2026-12-01')], TODAY)).toEqual([]);
	});
});

describe('acknowledge', () => {
	it('removes exactly the listed entries', () => {
		const a = held(ev('a', '2026-12-01'));
		const b = held(ev('b', '2026-12-02'));
		expect(acknowledge([a, b], [a])).toEqual([b]);
	});
});
