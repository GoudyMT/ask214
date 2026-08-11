import { describe, it, expect } from 'vitest';
import type { Resource } from './types';
import { resourcesForTask, groupByDisplayCategory } from './select';

function res(id: string, displayCategory: Resource['displayCategory']): Resource {
	return {
		id,
		title: id,
		url: `https://example.gov/${id}`,
		description: '',
		displayCategory,
		lastVerified: '2026-08-09'
	};
}

describe('resourcesForTask', () => {
	const R = [res('a', 'benefits-va'), res('b', 'employment'), res('c', 'finance')];

	it('returns the mapped resources for a task id, in the mapped order', () => {
		const map = { t1: ['b', 'a'] };
		expect(resourcesForTask('t1', map, R).map((r) => r.id)).toEqual(['b', 'a']);
	});

	it('returns empty for a task id that is not in the map', () => {
		expect(resourcesForTask('unknown', { t1: ['a'] }, R)).toEqual([]);
	});

	it('drops mapped ids that do not resolve to a resource', () => {
		const map = { t2: ['a', 'missing', 'c'] };
		expect(resourcesForTask('t2', map, R).map((r) => r.id)).toEqual(['a', 'c']);
	});
});

describe('groupByDisplayCategory', () => {
	it('groups resources by displayCategory, preserving input order within a group', () => {
		const resources = [res('a', 'benefits-va'), res('b', 'employment'), res('c', 'benefits-va')];
		const grouped = groupByDisplayCategory(resources);
		expect(grouped.get('benefits-va')?.map((r) => r.id)).toEqual(['a', 'c']);
		expect(grouped.get('employment')?.map((r) => r.id)).toEqual(['b']);
	});

	it('omits categories with no resources', () => {
		const grouped = groupByDisplayCategory([res('a', 'benefits-va')]);
		expect(grouped.has('finance')).toBe(false);
	});
});
