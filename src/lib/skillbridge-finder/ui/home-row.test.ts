import { describe, it, expect } from 'vitest';
import { finderHomeRow, type FinderHomeInput } from './home-row';

const READY: FinderHomeInput = {
	unlocked: true,
	online: true,
	setUp: true,
	missedWeeks: 0,
	newCount: 4,
	nearCount: 4,
	placeLabel: '21046'
};
const row = (over: Partial<FinderHomeInput>) => finderHomeRow({ ...READY, ...over });

describe('finderHomeRow', () => {
	it('shows what is new and how many are near the place, for a person with the finder open', () => {
		expect(row({})).toStrictEqual({
			name: 'SkillBridge',
			count: '4 new',
			detail: '4 near 21046'
		});
	});

	it('has no row for a person who has not set the finder up', () => {
		expect(row({ setUp: false })).toBeNull();
		expect(row({ setUp: false, unlocked: false })).toBeNull();
	});

	it('has no row offline, locked or not: the weekly news cannot be checked', () => {
		expect(row({ online: false })).toBeNull();
		expect(row({ online: false, unlocked: false })).toBeNull();
	});

	it('has no row after more than 4 missed weekly updates, but still has one at 4', () => {
		expect(row({ missedWeeks: 5 })).toBeNull();
		expect(row({ missedWeeks: 5, unlocked: false })).toBeNull();
		expect(row({ missedWeeks: 4 })).not.toBeNull();
	});

	it('shows only the name and a prompt while locked, whatever the counts and place are', () => {
		expect(row({ unlocked: false })).toStrictEqual({
			name: 'SkillBridge',
			detail: 'Unlock to see what is new'
		});
	});

	it('names the new programs when none is near the place', () => {
		expect(row({ newCount: 2, nearCount: 0 })).toStrictEqual({
			name: 'SkillBridge',
			count: '2 new',
			detail: 'New programs this week'
		});
	});

	it('names the new programs when no place is set', () => {
		expect(row({ placeLabel: null })).toStrictEqual({
			name: 'SkillBridge',
			count: '4 new',
			detail: 'New programs this week'
		});
	});

	it('says nothing is new, with no count, in a week with no new programs', () => {
		expect(row({ newCount: 0, nearCount: 0 })).toStrictEqual({
			name: 'SkillBridge',
			detail: 'No new programs this week'
		});
		expect(row({ newCount: 0, nearCount: 0, placeLabel: null })).toStrictEqual({
			name: 'SkillBridge',
			detail: 'No new programs this week'
		});
	});

	it('still counts the programs near the place in a week with none new, without a count', () => {
		expect(row({ newCount: 0, nearCount: 7 })).toStrictEqual({
			name: 'SkillBridge',
			detail: '7 near 21046'
		});
	});

	it('words a state as the place', () => {
		expect(row({ placeLabel: 'Maryland', newCount: 1, nearCount: 1 })).toStrictEqual({
			name: 'SkillBridge',
			count: '1 new',
			detail: '1 near Maryland'
		});
	});
});
