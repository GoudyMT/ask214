import { describe, it, expect } from 'vitest';
import type { DisplayCategory } from './types';
import {
	RESOURCES,
	TASK_RESOURCES,
	TASK_AFTER_LINK,
	TASK_LINK_NOTE,
	TASK_GUIDES
} from './resources';
import { LOCAL_DOCUMENT_INFO } from '#lib/sources/local-document-info.data.js';
import { linkNoteForTask, resourcesForTask } from './select';
import * as INDEX from './index';
import { TASK_DEFS } from '#lib/timeline/task-defs.js';
import { isGovernmentHost } from '#lib/sources/government-host.js';

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

	// The money tools (links to the official calculators and pay pages, no rates kept in the app): a money task
	// that shows no link leaves the member with the question and nowhere official to answer it.
	// Selling back or taking terminal leave is chosen before separation; a leave page shown only after it is too late.
	it('shows the leave page on a task that ends before separation, while the choice is open', () => {
		const before = TASK_DEFS.filter(
			(t) => t.windowEnd < 0 && resourcesForTask(t.id).some((r) => r.id === 'leave-transition')
		);
		expect(before.length).toBeGreaterThan(0);
	});

	it('every money task on the Timeline shows at least one official link', () => {
		const money = TASK_DEFS.filter((t) => t.category === 'finance');
		expect(money.length).toBeGreaterThan(0);
		for (const task of money) {
			const links = resourcesForTask(task.id);
			expect(links.length, task.id).toBeGreaterThan(0);
			for (const link of links)
				expect(isGovernmentHost(link.url), `${task.id} -> ${link.url}`).toBe(true);
		}
	});
});

describe('task-to-guide mapping: the TAP guides a task opens in the app', () => {
	it('every mapped guide is a guide the app serves (no dangling ids)', () => {
		for (const [taskId, guideIds] of Object.entries(TASK_GUIDES)) {
			for (const id of guideIds) {
				expect(Object.hasOwn(LOCAL_DOCUMENT_INFO, id), `${taskId} -> ${id}`).toBe(true);
			}
		}
	});

	it('every mapped task id is a real timeline task, with one or two guides, none twice', () => {
		const taskIds = new Set(TASK_DEFS.map((t) => t.id));
		for (const [taskId, guideIds] of Object.entries(TASK_GUIDES)) {
			expect(taskIds.has(taskId), taskId).toBe(true);
			expect(guideIds.length, taskId).toBeGreaterThanOrEqual(1);
			expect(guideIds.length, taskId).toBeLessThanOrEqual(2);
			expect(new Set(guideIds).size, taskId).toBe(guideIds.length);
		}
	});

	// The list the owner approved, task by task: a change to it is a curation decision, made here on purpose.
	it('matches the approved list', () => {
		expect(TASK_GUIDES).toEqual({
			'va-gov-account': ['tap_va_benefits_guide'],
			'login-gov-account': ['tap_va_benefits_guide'],
			'update-sgli': ['tap_va_life_insurance'],
			'will-poa': ['tap_financial_planning'],
			'financial-counselor': ['tap_financial_planning'],
			'master-resume': ['tap_dol_employment_workshop'],
			'gi-bill-research': ['tap_va_education_benefits', 'tap_managing_education'],
			'document-medical': ['tap_va_benefits_guide'],
			'preseparation-counseling': ['tap_pre_separation_brief'],
			'tap-course': ['tap_va_benefits_guide', 'tap_dol_efct'],
			'tap-track': ['tap_dol_employment_workshop', 'tap_managing_education'],
			'job-search': ['tap_dol_employment_workshop', 'tap_moc_crosswalk'],
			'health-insurance-research': ['tap_financial_planning', 'tap_pre_separation_brief'],
			'life-insurance-research': ['tap_va_life_insurance'],
			'va-career-guidance': ['tap_va_benefits_guide'],
			'jst-order': ['tap_managing_education'],
			'school-apply': ['tap_managing_education', 'tap_va_education_benefits'],
			'sha-schedule': ['tap_va_benefits_guide'],
			'sha-complete': ['tap_va_benefits_guide'],
			'va-bdd-claim': ['tap_va_disability_comp'],
			'tap-capstone': ['tap_managing_transition'],
			'va-benefits-advisor': ['tap_va_benefits_guide'],
			'financial-docs': ['tap_financial_planning'],
			'tricare-elect': ['tap_financial_planning'],
			'tsp-decision': ['tap_financial_planning'],
			'vgli-convert': ['tap_va_life_insurance'],
			'final-pay-check': ['tap_financial_planning'],
			'va-claim-fallback': ['tap_va_disability_comp']
		});
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

	// The portal takes a CAC or a DoD ID login, so the line names both.
	it('says the MyNavy Education portal takes a CAC or DoD ID login', () => {
		expect(RESOURCES.find((r) => r.id === 'mynavy-education')?.description).toBe(
			'The Navy portal where you submit your SkillBridge request (CAC or DoD ID login).'
		);
	});
});

// A member choosing a TAP track is deciding on a career path, which is where a mentor helps most.
describe('mentorship links sit on the career-planning steps', () => {
	it('lists the free mentoring programs after DoD TAP on the TAP track step', () => {
		expect(resourcesForTask('tap-track').map((r) => r.id)).toEqual(['dodtap', 'acp', 'milmentor']);
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
