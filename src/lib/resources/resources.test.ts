import { describe, it, expect } from 'vitest';
import type { DisplayCategory } from './types';
import { RESOURCES, TASK_RESOURCES, TASK_AFTER_LINK, TASK_LINK_NOTE } from './resources';
import { linkNoteForTask, resourcesForTask } from './select';
import * as INDEX from './index';
import { TASK_DEFS } from '$lib/timeline/task-defs';
import { isGovernmentHost } from '$lib/sources/government-host';

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

describe('what-now links: one official page per firm task', () => {
	const byId = new Map(RESOURCES.map((r) => [r.id, r]));

	it('links every firm task, and only the firm tasks', () => {
		const firm = TASK_DEFS.filter((t) => t.kind !== 'soft').map((t) => t.id);
		expect(Object.keys(TASK_AFTER_LINK).sort()).toEqual([...firm].sort());
	});

	// "The one official page": every What now link goes to a .gov or .mil host, the rule the source registry uses.
	it('sends every link to an official .gov or .mil page', () => {
		for (const [taskId, link] of Object.entries(TASK_AFTER_LINK)) {
			const url = byId.get(link.resource)?.url ?? '';
			expect(isGovernmentHost(url), `${taskId} -> ${url}`).toBe(true);
		}
	});

	it('points every link at a curated resource, with link text', () => {
		for (const [taskId, link] of Object.entries(TASK_AFTER_LINK)) {
			expect(byId.has(link.resource), `${taskId} -> ${link.resource}`).toBe(true);
			expect(link.label.trim().length, taskId).toBeGreaterThan(0);
		}
	});

	// The claims task links to a claims or benefits resource, whose host the 38 CFR test below pins to va.gov or
	// an accredited VSO.
	it('sends the VA claim task only to a claims or benefits resource', () => {
		for (const taskId of ['va-bdd-claim']) {
			const category = byId.get(TASK_AFTER_LINK[taskId]?.resource ?? '')?.displayCategory;
			expect(['claims-vso', 'benefits-va'], taskId).toContain(category);
		}
	});
});

describe("the line shown above a task card's links", () => {
	it('is set for the two SkillBridge steps only', () => {
		expect(Object.keys(TASK_LINK_NOTE).sort()).toEqual(['skillbridge-find', 'skillbridge-request']);
		const taskIds = new Set(TASK_DEFS.map((t) => t.id));
		for (const id of Object.keys(TASK_LINK_NOTE)) expect(taskIds.has(id), id).toBe(true);
	});

	it('is read by task id, and absent for any other task', () => {
		expect(linkNoteForTask('skillbridge-request')).toBe(
			"Also follow your command's SkillBridge instructions: they set what your request package needs."
		);
		expect(linkNoteForTask('skillbridge-find')).toBe(linkNoteForTask('skillbridge-request'));
		expect(linkNoteForTask('tap-course')).toBeUndefined();
	});

	it('is also reachable from the resources entry point, with the line it holds', () => {
		expect(INDEX.linkNoteForTask).toBe(linkNoteForTask);
		expect(INDEX.TASK_LINK_NOTE).toBe(TASK_LINK_NOTE);
		expect(INDEX.COMMAND_INSTRUCTIONS).toBe(linkNoteForTask('skillbridge-request'));
	});
});

describe('the SkillBridge steps link to the pages that carry them out', () => {
	it('lists the DoD page for the search and the Navy request pages for the request', () => {
		expect(resourcesForTask('skillbridge-find').map((r) => r.id)).toEqual(['skillbridge']);
		expect(resourcesForTask('skillbridge-request').map((r) => r.id)).toEqual([
			'mynavy-education',
			'navy-skillbridge'
		]);
	});

	it('points the two new links at their official Navy pages, checked on one day', () => {
		const byId = new Map(RESOURCES.map((r) => [r.id, r]));
		expect(byId.get('mynavy-education')).toMatchObject({
			url: 'https://myeducation.netc.navy.mil',
			displayCategory: 'skillbridge-transition',
			lastVerified: '2026-10-07'
		});
		expect(byId.get('navy-skillbridge')).toMatchObject({
			url: 'https://www.mynavyhr.navy.mil/Career-Management/Transition/SkillBridge/',
			displayCategory: 'skillbridge-transition',
			lastVerified: '2026-10-07'
		});
		for (const id of ['mynavy-education', 'navy-skillbridge']) {
			expect(isGovernmentHost(byId.get(id)?.url ?? ''), id).toBe(true);
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
