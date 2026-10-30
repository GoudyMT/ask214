import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TASK_DEFS } from '#lib/timeline/task-defs.js';
import { RESOURCES, TASK_AFTER_LINK, TASK_LINK_NOTE } from '#lib/resources/resources.js';
import * as LEAVING_COPY from '#lib/profile/leaving-copy.js';
import * as SKILLBRIDGE_COPY from '#lib/timeline/skillbridge-copy.js';

// The app serves members of every branch, officer and enlisted, with no branch question. A line that names one
// branch's portal, office, form or rule as THE way is false for everyone else, so these terms stay out of the
// copy a person reads. The About page's author line is not read here: it describes who built the app.
const FORBIDDEN =
	/\bNavy\b|MyNavy|NAVADMIN|NAVPERS|MILPERSMAN|\bEAOS\b|Active Obligated Service|\bsailors?\b|Fleet (?:and|&) Family|\bcommand's\b/i;
// A typographic apostrophe reads the same to a person, so it is read as a straight one.
const RIGHT_QUOTE = String.fromCharCode(0x2019);
const isForbidden = (text: string) => FORBIDDEN.test(text.replaceAll(RIGHT_QUOTE, "'"));

const ROUTES_WITH_DATE_FIELDS = [
	'../../routes/wizard/+page.svelte',
	'../../routes/settings/+page.svelte'
];

function userFacingCopy(): Array<[string, string]> {
	const copy: Array<[string, string]> = [];
	for (const def of TASK_DEFS) {
		copy.push([`task ${def.id} title`, def.title]);
		if (def.why) copy.push([`task ${def.id} why`, def.why]);
		if (def.afterNote) copy.push([`task ${def.id} afterNote`, def.afterNote]);
		if (def.changeNote) copy.push([`task ${def.id} changeNote`, def.changeNote]);
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
	// Every export of the SkillBridge copy, so a line added there later is read too; dated lines with a sample day.
	for (const [name, value] of Object.entries(SKILLBRIDGE_COPY)) {
		const lines =
			typeof value === 'string'
				? [value]
				: typeof value === 'function'
					? [value('2027-04-01')]
					: Object.values(value);
		for (const line of lines) copy.push([`skillbridge copy ${name}`, line]);
	}
	for (const path of ROUTES_WITH_DATE_FIELDS) {
		const source = readFileSync(new URL(path, import.meta.url), 'utf8');
		for (const m of source.matchAll(/\b(label|hint)="([^"]*)"/g)) {
			copy.push([`${path} ${m[1] ?? ''}`, m[2] ?? '']);
		}
	}
	return copy;
}

describe('user-facing copy serves every branch', () => {
	it("names no single branch's portal, office or rule", () => {
		const copy = userFacingCopy();
		// A floor on what was read, so a change in how the copy is written cannot leave this check reading nothing.
		expect(copy.length).toBeGreaterThan(200);
		const hits = copy
			.filter(([, text]) => isForbidden(text))
			.map(([where, text]) => `${where}: ${text}`);
		expect(hits).toEqual([]);
	});

	it('catches each Navy-only form it is meant to catch', () => {
		const planted = [
			'Sailors can start early.',
			'Submit your Navy separation package.',
			'Use MyNavy Education.',
			'Per NAVADMIN 064/23.',
			'Attach your NAVPERS 1306.',
			'See MILPERSMAN 1900-015.',
			'Your EAOS.',
			'Your End of Active Obligated Service.',
			'Visit Fleet & Family Support.',
			`Ask your command${RIGHT_QUOTE}s TAP office.`
		];
		expect(planted.filter((line) => !isForbidden(line))).toEqual([]);
	});
});
