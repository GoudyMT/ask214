import { describe, it, expect } from 'vitest';
import { TASK_DEFS, PHASE_BUCKETS } from './task-defs';
import { RESOURCES, TASK_AFTER_LINK, TASK_LINK_NOTE } from '$lib/resources/resources';
import * as SKILLBRIDGE_COPY from './skillbridge-copy';
import { DELETE_FILE_HINT, DEVICE_HINT, IOS_APP_HINT } from '$lib/calendar/delivery';
import {
	LEAVING_HINT,
	PAYGRADE_NOTE,
	ORDER_NOTE,
	AFTER_SEPARATION
} from '$lib/profile/leaving-copy';
import { makesPersonalClaim } from './personal-claim';

// Well-formedness guards for the seed: these pass for ANY valid seed, so editing the
// task CONTENT (titles, windows, why/value, gates) keeps them green as long as the
// shape stays valid.

describe('task-defs seed', () => {
	it('has unique task ids', () => {
		const ids = TASK_DEFS.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('has valid windows (start <= end) with the recommended offset inside the window', () => {
		for (const t of TASK_DEFS) {
			expect(t.windowStart).toBeLessThanOrEqual(t.windowEnd);
			const rec = t.recommendedOffset ?? t.windowStart;
			expect(rec).toBeGreaterThanOrEqual(t.windowStart);
			expect(rec).toBeLessThanOrEqual(t.windowEnd);
		}
	});

	it('orders phase buckets furthest-out first (strictly increasing startOffset)', () => {
		const offsets = PHASE_BUCKETS.map((b) => b.startOffset);
		expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
		expect(new Set(offsets).size).toBe(offsets.length);
	});

	it('gives every phase bucket a non-empty short label for the chip-strip', () => {
		// The full bucket.label is too long for a nav chip, so each bucket carries a compact
		// shortLabel. Well-formedness only (per this file's philosophy): editing the text keeps it green.
		for (const bucket of PHASE_BUCKETS) {
			expect(bucket.shortLabel).toBeTruthy();
			expect(typeof bucket.shortLabel).toBe('string');
		}
	});

	it('places every task inside the bucketed runway', () => {
		const first = PHASE_BUCKETS.at(0);
		const last = PHASE_BUCKETS.at(-1);
		expect(first).toBeDefined();
		expect(last).toBeDefined();
		if (!first || !last) return;
		for (const t of TASK_DEFS) {
			const rec = t.recommendedOffset ?? t.windowStart;
			expect(rec).toBeGreaterThanOrEqual(first.startOffset);
			expect(rec).toBeLessThan(last.endOffset);
		}
	});

	// Content placement: medical documentation must START early - it belongs in
	// the 18-12mo phase, not 12-6mo, so the VA-claim record has the longest runway. Buckets are
	// half-open [startOffset, endOffset), so the recommended offset must sit inside 18-12mo.
	it('schedules "start documenting medical conditions" in the 18-12 month phase', () => {
		const task = TASK_DEFS.find((t) => t.id === 'document-medical');
		const bucket = PHASE_BUCKETS.find((b) => b.id === '18-12mo');
		expect(task).toBeDefined();
		expect(bucket).toBeDefined();
		if (!task || !bucket) return;
		const offset = task.recommendedOffset ?? task.windowStart;
		expect(offset).toBeGreaterThanOrEqual(bucket.startOffset);
		expect(offset).toBeLessThan(bucket.endOffset);
	});

	it('gives every task a kind, and firm tasks a note for after their date', () => {
		for (const t of TASK_DEFS) {
			expect(['soft', 'required', 'closes']).toContain(t.kind);
			if (t.kind === 'soft') {
				expect(t.afterNote).toBeUndefined();
				expect(t.finalEnd).toBeUndefined();
			} else {
				expect(t.afterNote?.length ?? 0).toBeGreaterThan(0);
			}
		}
	});

	it('gives a two-edge task a later final edge and a note for between the edges', () => {
		for (const t of TASK_DEFS.filter((d) => d.finalEnd !== undefined)) {
			expect(t.kind).toBe('closes');
			expect(t.finalEnd).toBeGreaterThan(t.windowEnd);
			expect(t.changeNote?.length ?? 0).toBeGreaterThan(0);
		}
	});

	// The guard itself: every form of a personal claim it must catch, planted, and a public fact it must not.
	it('catches every planted form of a personal claim', () => {
		const planted = [
			'You get a government-paid final move for 180 days.',
			'You have 1 year to file.',
			'You still have 180 days for this.',
			'You are qualified for CHCBP.',
			'Coverage is guaranteed for 180 days.',
			`You${String.fromCharCode(0x2019)}re eligible for VGLI.`,
			"You'll get TAMP coverage.",
			'You may qualify for a special enrollment period.',
			'You might be eligible for TAMP.',
			'You could be entitled to a move.',
			'You will be eligible after you separate.',
			'You have up to 90 days.',
			'You have 6 months left.',
			'You have until your separation date.',
			'You receive 180 days of coverage.',
			'You are approved for SkillBridge.',
			`You${String.fromCharCode(0x2019)}re approved.`,
			"You're approved for the program.",
			'You will be approved if you submit early.',
			"You'll be approved for this.",
			'Your request will be approved.',
			'Your command will approve it.',
			'Your command will approve your request.',
			'The Navy will approve your request.',
			'Your SkillBridge request will be approved.',
			"You've been approved.",
			'You have been approved.',
			'You were approved for it.',
			'You should be approved.',
			"You'd be approved.",
			'You would be approved.',
			'You will likely be approved.',
			'You may be approved.',
			'Your OIC will approve it.',
			'Your CO will approve it.',
			'Your SkillBridge request will likely be approved.',
			'You might be approved.',
			'You could be approved.',
			'Your request should be approved.',
			'Your command would approve it.',
			'You are now approved.',
			"You'll get approved.",
			'Your package will get approved.',
			'You are already approved.',
			'You are also approved.',
			'Your request would already be approved.',
			'Your request will also be approved.',
			'Your request will now be approved.',
			'You would get approved.',
			'Your application will be approved.',
			'Your request for SkillBridge will be approved.',
			'Your request is approved.',
			'Your SkillBridge request has been approved.',
			'Your request was approved.',
			'Your request may be approved.',
			'Your request might be approved.',
			'Your request could be approved.',
			'Your request can be approved.',
			'You can be approved for SkillBridge.',
			'Ask your command who will approve your request.'
		];
		for (const line of planted) expect(makesPersonalClaim(line), line).toBe(true);
		expect(makesPersonalClaim('tricare.mil and healthcare.gov say who qualifies.')).toBe(false);
	});

	// Neutral facts about who decides, and the SkillBridge lines themselves, state no approval for the reader.
	it('lets neutral approval facts through', () => {
		const neutral = [
			"Print the request's pages for the package your command asks for; your command approver decides.",
			'Submit your SkillBridge request',
			'COs have final approval authority.',
			'COs and OICs approve SkillBridge requests.',
			'DoD approval covers your program dates.',
			"A request needs your command approver's signature before it goes up.",
			'Members who request SkillBridge within the DIB will be approved, per the DoD notice.',
			'Your command approver decides whether a request is approved.',
			'Ask your command whether your request is approved.',
			'Ask your command if your request is approved.',
			'Once your request is approved, tell your provider.',
			'Tell your provider when your request is approved.',
			'Wait until your request is approved.',
			'Find out who will approve your request.',
			"You'll find approved programs on skillbridge.mil.",
			'You will see approved providers in the portal.',
			'You may find approved programs near your base.',
			'Your command would need approved program dates.'
		];
		for (const line of neutral) expect(makesPersonalClaim(line), line).toBe(false);
	});

	// 38 CFR 14.629 over the task data: its own text, its What now link, the curated resources, the sentences under
	// the calendar button and the Settings lines beside the leaving dates. The words the components add around them
	// are checked in each component's tests.
	it('keeps every public line about a task free of personal eligibility claims', () => {
		// Every export of the SkillBridge copy module, so a line added there later is checked too; dated lines with a
		// sample day.
		const skillbridgeLines = Object.values(SKILLBRIDGE_COPY).flatMap((v): string[] =>
			typeof v === 'string' ? [v] : typeof v === 'function' ? [v('2027-04-01')] : Object.values(v)
		);
		expect(skillbridgeLines.length).toBeGreaterThanOrEqual(17);
		const lines = [
			...TASK_DEFS.flatMap((t) => [t.title, t.why, t.afterNote ?? '', t.changeNote ?? '']),
			...Object.values(TASK_AFTER_LINK).map((link) => link.label),
			...RESOURCES.flatMap((r) => [r.title, r.description]),
			...[...Object.values(DEVICE_HINT), IOS_APP_HINT].map((hint) => `${hint.lead} ${hint.text}`),
			DELETE_FILE_HINT,
			LEAVING_HINT,
			PAYGRADE_NOTE,
			ORDER_NOTE,
			AFTER_SEPARATION,
			...skillbridgeLines,
			...Object.values(TASK_LINK_NOTE)
		];
		expect(lines.length).toBeGreaterThan(200);
		for (const line of lines) expect(makesPersonalClaim(line), line).toBe(false);
	});
});

// Each firm deadline pinned to the public source it comes from, so a later edit cannot drift from the rule.
describe('firm deadlines match their official sources', () => {
	const at = (id: string) => TASK_DEFS.find((t) => t.id === id);

	it.each([
		// 10 USC 1142 - counseling "shall commence not later than 365 days before"
		['preseparation-counseling', 'required', -365, undefined],
		// militaryonesource.mil TAP - the Capstone "no later than 90 days before separation"
		['tap-capstone', 'required', -90, undefined],
		// va.gov pre-discharge claim - "between 180 to 90 days before you leave the military"
		['va-bdd-claim', 'closes', -90, undefined],
		// tricare.mil CHCBP - "enroll within 60 days of losing your eligibility for TRICARE"
		['tricare-elect', 'closes', 60, undefined],
		// va.gov VGLI - 240 days with no health questions; "within 1 year and 120 days"
		['vgli-convert', 'closes', 240, 485],
		// militaryonesource.mil - "those separating before retirement have 180 days"
		['hhg-counseling', 'closes', 180, undefined],
		// 38 CFR 3.400(b)(2)(i) - a claim "received within 1 year after separation" keeps the earliest effective
		// date. It is an effective-date rule, not a filing deadline, so the task is soft: no last day, never closed.
		['va-claim-fallback', 'soft', 365, undefined],
		// tricare.mil TAMP - a Selected Reservist "the day immediately following release"; affiliating later is still
		// possible, so the task is soft with its aim at separation.
		['reserve-affiliation', 'soft', 0, undefined]
	] as const)('%s is %s with its last day at %d', (id, kind, windowEnd, finalEnd) => {
		const t = at(id);
		expect(t?.kind).toBe(kind);
		expect(t?.windowEnd).toBe(windowEnd);
		expect(t?.finalEnd).toBe(finalEnd);
	});

	// Copy that has to carry the condition its source carries, so a later edit cannot drop it.
	it('keeps the conditions the sources state in the coverage, move, VGLI and TAP lines', () => {
		// tricare.mil: TAMP gives 180 more days of coverage, and the CHCBP window runs from the end of TAMP.
		expect(at('tricare-elect')?.why).toContain('TAMP');
		expect(at('tricare-elect')?.afterNote).toContain('TAMP');
		// healthcare.gov: a Marketplace period opens for coverage a person "expects to lose ... in the next 60 days".
		expect(at('tricare-elect')?.why).toContain('60 days before');
		// militaryonesource.mil: "Final move entitlements vary ... confirm with your installation's Transportation Office".
		expect(at('hhg-counseling')?.why).toContain('confirm with your transportation office');
		// va.gov SGLI: a member totally disabled at separation keeps free SGLI longer, then VGLI is offered.
		expect(at('vgli-convert')?.afterNote).toContain('standard VGLI deadline');
		// TAP's three mandatory courses: Transition Day (militaryonesource.mil), VA Benefits and Services (va.gov, "part
		// of the required TAP Curriculum") and DOL's one-day course (dol.gov, "their DOL one-day EFCT requirement").
		for (const course of [
			'Transition Day',
			'VA Benefits and Services',
			'Employment Fundamentals of Career Transition'
		]) {
			expect(at('tap-course')?.why).toContain(course);
		}
	});

	// MILPERSMAN 1900-015 CH-93: the complete separation package "no less than 120 days from commencement of PTDY or
	// separation leave" (2.b(3)) sets its last day; complete packages 5 to 9 months before separation (2.a) set its
	// opening and aim, counted here from the leaving day like the last day. A DD 214 not final 14 days before
	// departure on PTDY or separation leave is finalized without the member's signature (2.a), so its last day is the
	// day before that mark. The leaving day includes a SkillBridge start: its participants are on permissive TDY
	// orders (NAVADMIN 160/22 5.e), read here as that departure, and SkillBridge comes first.
	it("counts the separation package and the DD-214 review from the leaving day, with CH-93's last days", () => {
		expect(at('separation-package')).toMatchObject({
			countsFrom: 'leaving',
			windowStart: -270,
			recommendedOffset: -150,
			windowEnd: -120
		});
		expect(at('dd214-review')).toMatchObject({ countsFrom: 'leaving', windowEnd: -15 });
	});

	// skillbridge.mil notice, June 3, 2026: members "in the last 180 days of their service who request SkillBridge
	// participation within the DIB will be approved", an exception to the Service rank limits the note lists.
	it('names the defense industry exception beside the paygrade limits', () => {
		expect(PAYGRADE_NOTE).toContain(
			'Defense industry (DIB) programs can start up to 180 days out at any rank (Department of War notice, June 2026).'
		);
	});

	// Two of these numbers come from a sailor's experience, not a written rule: the search for a program starts about
	// 14 months out (426 days), and the request opens at the 364-day mark, where the portal opens; both aim at their
	// opening. The written sources fix the rest: NAVADMIN 160/22 8.a's "up to 365 days before" bounds the opening, and
	// the request window runs to 201 days out: the longest program, 180 days (NAVADMIN 064/23 tier one), plus "at
	// least 3 weeks prior to start date" (MyNavyHR's SkillBridge timeline).
	it('times the SkillBridge steps from their sources', () => {
		expect(at('skillbridge-find')).toMatchObject({
			kind: 'soft',
			windowStart: -426,
			recommendedOffset: -426,
			windowEnd: -365
		});
		expect(at('skillbridge-request')).toMatchObject({
			kind: 'soft',
			windowStart: -364,
			recommendedOffset: -364,
			windowEnd: -201
		});
		expect(at('skillbridge-request')?.why).toContain('at least 3 weeks before your start');
		expect(at('skillbridge-find')?.why).toContain('DoD approval covers your program dates');
	});

	// The locked wording of both steps, in full, so a later edit to any part of it fails here.
	it('words the SkillBridge steps exactly as approved', () => {
		expect(at('skillbridge-find')).toMatchObject({
			title: 'Find a SkillBridge program and get an acceptance letter',
			why: 'Start about 14 months out: pick a reputable program whose DoD approval covers your program dates, and get its acceptance letter.'
		});
		expect(at('skillbridge-request')).toMatchObject({
			title: "Submit your SkillBridge request (MyNavy Education and your command's package)",
			why: "It opens a year before separation; submit as soon as it opens, at least 3 weeks before your start. Print the request's pages for the package your command asks for; your command approver decides."
		});
	});

	it('files both SkillBridge steps under career, to finish before leaving the command', () => {
		for (const id of ['skillbridge-find', 'skillbridge-request']) {
			expect(at(id), id).toMatchObject({ category: 'career', finishBefore: 'leaving' });
		}
	});

	it('words the dated SkillBridge lines with the day shown the way the timeline shows it', () => {
		expect(SKILLBRIDGE_COPY.askAgainLine('2027-04-01')).toBe(
			"We'll ask again on Apr 1, 2027. You can change this in Settings."
		);
		expect(SKILLBRIDGE_COPY.rowHintEarly('2027-04-01')).toBe(
			"Yes adds SkillBridge's steps to your timeline. Not sure asks again on Apr 1, 2027."
		);
	});

	it('opens the Capstone at 12 months and Chapter 36 counseling 180 days before separation', () => {
		expect(at('tap-capstone')?.windowStart).toBe(-365);
		expect(at('va-career-guidance')?.windowStart).toBe(-180);
		expect(at('va-career-guidance')?.windowEnd).toBe(365);
	});
});

describe('what each task must finish before', () => {
	const by = (value: string) =>
		TASK_DEFS.filter((t) => t.finishBefore === value)
			.map((t) => t.id)
			.sort();

	it('TAP and the command-side tasks finish before leaving the command', () => {
		expect(by('leaving')).toEqual(
			[
				'dd214-review',
				'document-medical',
				'preseparation-counseling',
				'reference-letters',
				'separation-package',
				'skillbridge-find',
				'skillbridge-request',
				'tap-capstone',
				'tap-course',
				'tap-track',
				'verify-service-record'
			].sort()
		);
	});

	it('the separation health assessment finishes before terminal leave only', () => {
		expect(by('terminal-leave')).toEqual(['sha-complete', 'sha-schedule']);
	});

	it('every other task, the track fixes included, counts from separation alone', () => {
		const rest = by('separation');
		for (const id of ['update-sgli', 'financial-docs', 'hhg-counseling'])
			expect(rest).toContain(id);
		expect(rest.length + by('leaving').length + by('terminal-leave').length).toBe(TASK_DEFS.length);
	});

	it('only a separation-counted task may have a second edge', () => {
		for (const t of TASK_DEFS)
			if (t.finalEnd !== undefined) expect(t.finishBefore).toBe('separation');
	});

	it('only the separation package and the DD-214 review count from the leaving day, and both finish before it', () => {
		const counted = TASK_DEFS.filter((t) => t.countsFrom === 'leaving');
		expect(counted.map((t) => t.id).sort()).toEqual(['dd214-review', 'separation-package']);
		for (const t of counted) expect(t.finishBefore).toBe('leaving');
	});

	// A task finished before the user leaves the command, or counted from that day, is over before separation: no one
	// leaves the command after they separate.
	it('every task finished before leaving, or counted from it, ends before separation', () => {
		const leavingTasks = TASK_DEFS.filter(
			(t) => t.finishBefore !== 'separation' || t.countsFrom === 'leaving'
		);
		expect(leavingTasks.length).toBeGreaterThan(0);
		for (const t of leavingTasks) expect(t.windowEnd, t.id).toBeLessThan(0);
	});
});
