import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TASK_DEFS } from '#lib/timeline/task-defs.js';
import { RESOURCES, TASK_AFTER_LINK, TASK_LINK_NOTE } from '#lib/resources/resources.js';
import * as LEAVING_COPY from '#lib/profile/leaving-copy.js';

// The app serves members of every branch, officer and enlisted, with no branch question. A line that names one
// branch's portal, office, form or rule as THE way is false for everyone else, so these terms stay out of the
// copy a person reads. The About page's author line is not read here: it describes who built the app.
const FORBIDDEN = /\bNavy\b|MyNavy|NAVADMIN|\bEAOS\b|\bsailors?\b|Fleet and Family|\bcommand's\b/;

const ROUTES_WITH_DATE_LABELS = [
	'../../routes/wizard/+page.svelte',
	'../../routes/settings/+page.svelte'
];

function userFacingCopy(): Array<[string, string]> {
	const copy: Array<[string, string]> = [];
	for (const def of TASK_DEFS) {
		copy.push([`task ${def.id} title`, def.title]);
		if (def.why) copy.push([`task ${def.id} why`, def.why]);
		if (def.afterNote) copy.push([`task ${def.id} afterNote`, def.afterNote]);
	}
	for (const r of RESOURCES) {
		copy.push([`resource ${r.id} title`, r.title]);
		copy.push([`resource ${r.id} description`, r.description]);
	}
	for (const [task, link] of Object.entries(TASK_AFTER_LINK))
		copy.push([`after link ${task}`, link.label]);
	for (const [task, note] of Object.entries(TASK_LINK_NOTE)) copy.push([`link note ${task}`, note]);
	for (const [name, value] of Object.entries(LEAVING_COPY)) {
		if (typeof value === 'string') copy.push([`leaving copy ${name}`, value]);
	}
	for (const path of ROUTES_WITH_DATE_LABELS) {
		const source = readFileSync(new URL(path, import.meta.url), 'utf8');
		for (const m of source.matchAll(/\blabel="([^"]*)"/g)) copy.push([`${path} label`, m[1] ?? '']);
	}
	return copy;
}

describe('user-facing copy serves every branch', () => {
	it("names no single branch's portal, office or rule", () => {
		const hits = userFacingCopy()
			.filter(([, text]) => FORBIDDEN.test(text))
			.map(([where, text]) => `${where}: ${text}`);
		expect(hits).toEqual([]);
	});
});
