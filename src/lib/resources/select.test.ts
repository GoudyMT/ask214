import { describe, it, expect } from 'vitest';
import type { Resource } from './types';
import {
	resourcesForTask,
	groupByDisplayCategory,
	afterLinkForTask,
	guidesForTask
} from './select';

describe('guidesForTask', () => {
	const INFO = { g1: { title: 'Guide one' }, g2: { title: 'Guide two' } };

	it('returns the mapped guides with their titles, in the mapped order', () => {
		expect(guidesForTask('t1', { t1: ['g2', 'g1'] }, INFO)).toEqual([
			{ sourceId: 'g2', title: 'Guide two' },
			{ sourceId: 'g1', title: 'Guide one' }
		]);
	});

	it('returns empty for a task id that is not in the map', () => {
		expect(guidesForTask('unknown', { t1: ['g1'] }, INFO)).toEqual([]);
	});

	// The maps are plain objects: a name every object inherits is not a task or a guide.
	it('reads only the maps own entries, never what every object inherits', () => {
		expect(guidesForTask('constructor', { t1: ['g1'] }, INFO)).toEqual([]);
		expect(guidesForTask('t1', { t1: ['toString', 'g1'] }, INFO)).toEqual([
			{ sourceId: 'g1', title: 'Guide one' }
		]);
	});

	it('drops a mapped id the app does not serve', () => {
		expect(guidesForTask('t1', { t1: ['gone', 'g1'] }, INFO)).toEqual([
			{ sourceId: 'g1', title: 'Guide one' }
		]);
	});
});

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

describe('afterLinkForTask', () => {
	const R = [res('a', 'claims-vso')];

	it('returns the link text and the resource url for a linked task', () => {
		const map = { t1: { resource: 'a', label: 'Find a VSO' } };
		expect(afterLinkForTask('t1', map, R)).toEqual({
			label: 'Find a VSO',
			url: 'https://example.gov/a'
		});
	});

	it('returns undefined for a task with no link, or a link that does not resolve', () => {
		expect(afterLinkForTask('t2', { t1: { resource: 'a', label: 'x' } }, R)).toBeUndefined();
		expect(afterLinkForTask('t1', { t1: { resource: 'missing', label: 'x' } }, R)).toBeUndefined();
	});

	it('reads the curated map by default', () => {
		expect(afterLinkForTask('va-bdd-claim')).toEqual({
			label: 'Find a VSO on VA.gov',
			url: 'https://www.va.gov/get-help-from-accredited-representative/'
		});
		expect(afterLinkForTask('will-poa')).toBeUndefined();
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
