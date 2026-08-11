import { describe, it, expect } from 'vitest';
import type { DisplayCategory } from './types';
import { RESOURCES, TASK_RESOURCES } from './resources';
import { TASK_DEFS } from '$lib/timeline/task-defs';

const DISPLAY_CATEGORIES = new Set<DisplayCategory>([
	'benefits-va',
	'claims-vso',
	'employment',
	'education',
	'finance',
	'skillbridge-transition',
	'mentorship-networking',
	'health-wellbeing'
]);

describe('curated resources data integrity', () => {
	it('every resource has non-empty id, title, url, and description', () => {
		for (const r of RESOURCES) {
			expect(r.id, r.id).toBeTruthy();
			expect(r.title, r.id).toBeTruthy();
			expect(r.url, r.id).toBeTruthy();
			expect(r.description, r.id).toBeTruthy();
		}
	});

	it('every url is https (no insecure or non-web links)', () => {
		for (const r of RESOURCES) {
			expect(r.url.startsWith('https://'), `${r.id}: ${r.url}`).toBe(true);
		}
	});

	it('every displayCategory is one of the known browse categories', () => {
		for (const r of RESOURCES) {
			expect(DISPLAY_CATEGORIES.has(r.displayCategory), `${r.id}: ${r.displayCategory}`).toBe(true);
		}
	});

	it('ids are unique', () => {
		const ids = RESOURCES.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('lastVerified is an ISO date (YYYY-MM-DD)', () => {
		for (const r of RESOURCES) {
			expect(/^\d{4}-\d{2}-\d{2}$/.test(r.lastVerified), `${r.id}: ${r.lastVerified}`).toBe(true);
			expect(Number.isNaN(Date.parse(r.lastVerified)), r.id).toBe(false);
		}
	});
});

describe('task-to-resource mapping integrity', () => {
	it('every mapped resource id resolves to a real resource (no dangling ids)', () => {
		const ids = new Set(RESOURCES.map((r) => r.id));
		for (const [taskId, resIds] of Object.entries(TASK_RESOURCES)) {
			for (const id of resIds) {
				expect(ids.has(id), `${taskId} -> ${id}`).toBe(true);
			}
		}
	});

	it('every mapped task lists at least one resource', () => {
		for (const [taskId, resIds] of Object.entries(TASK_RESOURCES)) {
			expect(resIds.length, taskId).toBeGreaterThan(0);
		}
	});

	it('every mapped task id is a real timeline task (no dead keys)', () => {
		const taskIds = new Set(TASK_DEFS.map((t) => t.id));
		for (const taskId of Object.keys(TASK_RESOURCES)) {
			expect(taskIds.has(taskId), taskId).toBe(true);
		}
	});

	it('no task lists a duplicate resource id', () => {
		for (const [taskId, resIds] of Object.entries(TASK_RESOURCES)) {
			expect(new Set(resIds).size, taskId).toBe(resIds.length);
		}
	});
});

describe('38 CFR 14.629 boundary: claims and benefits links stay official or accredited', () => {
	// Claims and benefits destinations must be official .gov or a VA-accredited VSO - never an
	// unaccredited or paid claims consultant. This makes the boundary an executable guard.
	const ALLOWED_HOSTS = new Set(['www.va.gov', 'www.dav.org', 'www.vfw.org', 'www.legion.org']);

	it('every claims-vso and benefits-va url is on an allowed official or accredited host', () => {
		for (const r of RESOURCES) {
			if (r.displayCategory === 'claims-vso' || r.displayCategory === 'benefits-va') {
				expect(ALLOWED_HOSTS.has(new URL(r.url).host), `${r.id}: ${r.url}`).toBe(true);
			}
		}
	});
});
