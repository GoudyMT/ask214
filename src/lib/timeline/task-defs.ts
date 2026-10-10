import type { TaskDef, PhaseBucket } from './types';

/**
 * Phase buckets for the timeline view: the 24-month runway, furthest-out first.
 * A task is grouped into the bucket whose [startOffset, endOffset) contains its
 * target date's offset (the fitted one when Fit moved it); empty buckets are dropped at render (generation).
 *
 * Offsets are days relative to EAOS (negative = before separation). The 'after' bucket
 * runs out to +730d to hold late post-separation deadlines (e.g. VGLI conversion).
 */
export const PHASE_BUCKETS: readonly PhaseBucket[] = [
	{
		id: '24-18mo',
		label: '24-18 months out',
		shortLabel: '24-18 mo',
		startOffset: -730,
		endOffset: -540
	},
	{
		id: '18-12mo',
		label: '18-12 months out',
		shortLabel: '18-12 mo',
		startOffset: -540,
		endOffset: -365
	},
	{
		id: '12-6mo',
		label: '12-6 months out',
		shortLabel: '12-6 mo',
		startOffset: -365,
		endOffset: -180
	},
	{ id: '6-3mo', label: '6-3 months out', shortLabel: '6-3 mo', startOffset: -180, endOffset: -90 },
	{ id: 'final90', label: 'Final 90 days', shortLabel: 'Final 90', startOffset: -90, endOffset: 0 },
	{ id: 'after', label: 'After separation', shortLabel: 'After', startOffset: 0, endOffset: 730 }
];

/**
 * v1.0 SEED task definitions (US Navy AD Enlisted ETS), research-reconciled against
 * current DoD/VA/DoL/Navy sources (2024-2026). Timing is anchored to the EAOS; when the profile holds a
 * SkillBridge or terminal leave start, a task's last day comes in to fit before the date it must finish before
 * (`finishBefore`), and its opening never moves - except a task whose rule counts from the leaving day
 * (`countsFrom`), which moves its whole window.
 *
 * Tasks with no authoritative fixed date use a wide early window (best-practice prep). `requires` gates a task on
 * a persona field (hidden until set + matched).
 *
 * Authored and confirmed from lived Navy-ETS experience, backed by a research pass.
 */
export const TASK_DEFS: readonly TaskDef[] = [
	// ---- Early prep (no authoritative fixed date; recommended 18-24 months out) ----
	{
		id: 'va-gov-account',
		title: 'Sign in to VA.gov and check your profile',
		category: 'admin',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'Your VA.gov account is the gateway to claims, health care, and records.'
	},
	{
		id: 'login-gov-account',
		title: 'Set up Login.gov or ID.me',
		category: 'admin',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'Login.gov or ID.me is the secure sign-in for VA.gov and other federal services.'
	},
	{
		id: 'update-sgli',
		title: 'Review your SGLI coverage and beneficiaries',
		category: 'finance',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'Coverage amounts and beneficiaries drift out of date.'
	},
	{
		id: 'verify-service-record',
		title: 'Verify your service record is accurate (awards, training)',
		category: 'admin',
		finishBefore: 'leaving',
		kind: 'soft',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'Record errors are far easier to fix while you are still in.'
	},
	{
		id: 'will-poa',
		title: 'Create a will and power of attorney',
		category: 'admin',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -730,
		windowEnd: -90,
		recommendedOffset: -540,
		why: 'Legal documents take time and are easy to put off.'
	},
	{
		id: 'financial-counselor',
		title: 'Meet a personal financial counselor',
		category: 'finance',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'A transition changes your pay, benefits, and budget.'
	},
	{
		id: 'master-resume',
		title: 'Create a master resume',
		category: 'career',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -540,
		windowEnd: -120,
		recommendedOffset: -450,
		why: 'Translating military experience into civilian terms takes several drafts.'
	},
	{
		id: 'gi-bill-research',
		title: 'Research your GI Bill and education options',
		category: 'benefits',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'Education benefits and school timelines take months to line up.'
	},
	{
		id: 'document-medical',
		title: 'Start documenting any medical conditions',
		category: 'medical',
		finishBefore: 'leaving',
		kind: 'soft',
		windowStart: -540,
		windowEnd: -180,
		recommendedOffset: -450,
		why: 'Conditions documented now build the record your VA claim relies on.'
	},

	// ---- TAP / counseling (federally anchored) ----
	{
		id: 'preseparation-counseling',
		title: 'Complete Initial and Pre-separation Counseling',
		category: 'admin',
		finishBefore: 'leaving',
		kind: 'required',
		windowStart: -540,
		windowEnd: -365,
		recommendedOffset: -400,
		why: 'TAP officially starts here, and it is required no later than 365 days out.',
		afterNote: "Still required. Contact your command's Transition Assistance office to start now."
	},
	{
		id: 'tap-course',
		title: 'Attend your required TAP curriculum',
		category: 'admin',
		finishBefore: 'leaving',
		kind: 'soft',
		windowStart: -365,
		windowEnd: -120,
		recommendedOffset: -270,
		why: 'Transition Day, VA Benefits and Services, and the DOL Employment Fundamentals of Career Transition course are mandatory.'
	},
	{
		id: 'tap-track',
		title: 'Attend a TAP 2-day track (Employment / Education / Vocational / Entrepreneurship)',
		category: 'admin',
		finishBefore: 'leaving',
		kind: 'soft',
		windowStart: -365,
		windowEnd: -120,
		recommendedOffset: -240,
		why: 'Each member picks one focused 2-day track for their path.'
	},

	// ---- SkillBridge: shown only when the user's answer to the SkillBridge question shows them ----
	{
		id: 'skillbridge-find',
		title: 'Find a SkillBridge program and get an acceptance letter',
		category: 'career',
		finishBefore: 'leaving',
		skillbridgeStep: true,
		kind: 'soft',
		windowStart: -426,
		windowEnd: -365,
		recommendedOffset: -426,
		why: 'Start about 14 months out: pick a reputable program whose DoD approval covers your program dates, and get its acceptance letter.'
	},
	{
		id: 'skillbridge-request',
		title: "Submit your SkillBridge request (MyNavy Education and your command's package)",
		category: 'career',
		finishBefore: 'leaving',
		skillbridgeStep: true,
		kind: 'soft',
		windowStart: -364,
		windowEnd: -201,
		recommendedOffset: -364,
		why: "It opens a year before separation; submit as soon as it opens, at least 3 weeks before your start. Print the request's pages for the package your command asks for; your command approver decides."
	},

	// ---- Job / benefits prep (mid window) ----
	{
		id: 'job-search',
		title: 'Begin and refine your job search',
		category: 'career',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -365,
		windowEnd: -30,
		recommendedOffset: -270,
		why: 'Job searches take months from first application to offer.'
	},
	{
		id: 'health-insurance-research',
		title: 'Research your health-coverage options (TRICARE/TAMP, civilian)',
		category: 'benefits',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -365,
		windowEnd: -90,
		recommendedOffset: -270,
		why: 'Coverage can lapse the day you separate if you do not plan.'
	},
	{
		id: 'life-insurance-research',
		title: 'Research life-insurance options for you and your family',
		category: 'benefits',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -365,
		windowEnd: -90,
		recommendedOffset: -270,
		why: 'SGLI stays free for 120 days after you separate; VGLI and civilian options differ in cost and coverage.'
	},
	{
		id: 'va-career-guidance',
		title: 'Apply for VA personalized career planning and guidance',
		category: 'career',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -180,
		windowEnd: 365,
		recommendedOffset: -120,
		why: 'VA offers free career counseling (Chapter 36) to map your path.'
	},
	{
		id: 'jst-order',
		title: 'Order your Joint Services Transcript (JST)',
		category: 'career',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -180,
		windowEnd: -90,
		recommendedOffset: -150,
		why: 'Schools and employers use your JST to credit your military training.'
	},
	{
		id: 'reserve-affiliation',
		title: 'Start reserve affiliation',
		category: 'career',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -300,
		windowEnd: 0,
		recommendedOffset: -180,
		why: 'Affiliating with the reserves takes paperwork and lead time. TAMP coverage through the Selected Reserve requires joining the day after you separate.',
		requires: { intendedPath: ['reserves'] }
	},
	{
		id: 'school-apply',
		title: 'Apply to schools and submit the FAFSA',
		category: 'benefits',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -270,
		windowEnd: -90,
		recommendedOffset: -180,
		why: 'School application and financial-aid deadlines are fixed and early.',
		requires: { intendedPath: ['school'] }
	},

	// ---- Separation health assessment + VA claim (BDD) ----
	{
		id: 'sha-schedule',
		title: 'Schedule your Separation Health Assessment (SHA)',
		category: 'medical',
		finishBefore: 'terminal-leave',
		kind: 'required',
		windowStart: -180,
		windowEnd: -90,
		recommendedOffset: -150,
		why: 'The SHA is one exam that serves both your separation and your VA claim - book it early.',
		afterNote: "Still required before you separate. Contact your command's medical department."
	},
	{
		id: 'sha-complete',
		title: 'Complete your SHA (physical, dental, audiogram) and the Part A self-assessment',
		category: 'medical',
		finishBefore: 'terminal-leave',
		kind: 'required',
		windowStart: -150,
		windowEnd: -90,
		recommendedOffset: -120,
		why: 'Part A is the self-assessment your VA (BDD) claim is built on.',
		afterNote: "Still required before you separate. Contact your command's medical department."
	},
	{
		id: 'va-bdd-claim',
		title: 'File your VA disability claim through BDD (Benefits Delivery at Discharge)',
		category: 'benefits',
		finishBefore: 'separation',
		kind: 'closes',
		windowStart: -180,
		windowEnd: -90,
		recommendedOffset: -120,
		why: 'Filing 180-90 days out is the fastest path and often decides your claim near separation; you must be available for VA exams within 45 days.',
		afterNote:
			'BDD is no longer available. A VA claim can still be filed the standard way, and an accredited VSO helps for free.'
	},

	// ---- Capstone + final-90 ----
	{
		id: 'tap-capstone',
		title: 'Complete your TAP Capstone',
		category: 'admin',
		finishBefore: 'leaving',
		kind: 'required',
		windowStart: -365,
		windowEnd: -90,
		recommendedOffset: -120,
		why: 'Your commander verifies you meet Career Readiness Standards no later than 90 days out.',
		afterNote: "Still required before you separate. Contact your command's TAP office."
	},
	{
		id: 'va-benefits-advisor',
		title: 'Meet one-on-one with a VA benefits advisor',
		category: 'benefits',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -180,
		windowEnd: -60,
		recommendedOffset: -120,
		why: 'A benefits advisor helps you claim everything you earned.'
	},
	{
		id: 'reference-letters',
		title: 'Gather reference and recommendation letters',
		category: 'career',
		finishBefore: 'leaving',
		kind: 'soft',
		windowStart: -180,
		windowEnd: -30,
		recommendedOffset: -120,
		why: 'Ask while your work is fresh and your leaders are still available.'
	},
	{
		id: 'financial-docs',
		title: 'Save your LES history, myPay access, and SGLI election',
		category: 'finance',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -120,
		windowEnd: -30,
		recommendedOffset: -90,
		why: 'You lose easy access to military pay records after you separate.'
	},
	{
		id: 'hhg-counseling',
		title: 'Arrange your household-goods (HHG) move',
		category: 'admin',
		finishBefore: 'separation',
		kind: 'closes',
		windowStart: -180,
		windowEnd: 180,
		recommendedOffset: -120,
		why: 'The government-paid final move generally runs 180 days after you separate; confirm with your transportation office.',
		afterNote:
			'The government-paid move ends 180 days after separation unless an extension is approved; contact your installation transportation office.'
	},
	{
		id: 'separation-package',
		title: 'Submit your Navy separation package (1306, eval, award, statement of service)',
		category: 'admin',
		finishBefore: 'leaving',
		countsFrom: 'leaving',
		kind: 'required',
		windowStart: -270,
		windowEnd: -120,
		recommendedOffset: -150,
		why: 'Your admin office must send it to the Navy at least 120 days before you leave: SkillBridge, terminal leave or separation, whichever comes first.',
		afterNote: 'Still required; a late package can delay your orders, DD-214 and final pay.'
	},
	{
		id: 'dd214-review',
		title: 'Review your DD-2648 and DD-214 for accuracy',
		category: 'admin',
		finishBefore: 'leaving',
		kind: 'soft',
		countsFrom: 'leaving',
		windowStart: -90,
		windowEnd: -15,
		recommendedOffset: -30,
		why: 'If it is not final 14 days before you leave, the Navy can finalize it without your signature.'
	},

	// ---- Near / at separation ----
	{
		id: 'tricare-elect',
		title: 'Choose your health coverage for after TRICARE (CHCBP or the Marketplace)',
		category: 'benefits',
		finishBefore: 'separation',
		kind: 'closes',
		windowStart: -60,
		windowEnd: 60,
		recommendedOffset: -14,
		why: 'A Marketplace special enrollment period runs from 60 days before to 60 days after TRICARE (or TAMP) ends, and CHCBP enrollment within 60 days after; tricare.mil and healthcare.gov say who qualifies.',
		afterNote:
			'If your coverage ended when you separated, the 60-day window has passed. TAMP coverage ends later and moves it; see tricare.mil and healthcare.gov.'
	},
	{
		id: 'dd214-copies',
		title: 'Make several certified copies of your DD-214 (member-4)',
		category: 'admin',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -7,
		windowEnd: 60,
		recommendedOffset: 0,
		why: 'You will need DD-214 copies for years of benefits, jobs, and schools.'
	},

	// ---- After separation ----
	{
		id: 'tsp-decision',
		title: 'Decide on your TSP and pay off any TSP loan',
		category: 'finance',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: 0,
		windowEnd: 90,
		recommendedOffset: 30,
		why: 'Your TSP and any TSP loan have rules after you separate; tsp.gov explains your options.'
	},
	{
		id: 'vgli-convert',
		title: 'Convert your SGLI to VGLI',
		category: 'benefits',
		finishBefore: 'separation',
		kind: 'closes',
		windowStart: 0,
		windowEnd: 240,
		// 485 days, as VA counts it: "SGLI can no longer be converted after 485 Days" (VA's Guard and Reserve benefits
		// page) and "1 YEAR & 120 DAYS (485 DAYS)" (the TAP VA Benefits and Services Participant Guide). Read as a
		// calendar year and 120 days, a Feb 29 in between makes it a day later, so 485 is never late under any reading.
		finalEnd: 485,
		recommendedOffset: 30,
		why: 'You can convert with no health questions within 240 days of separation (hard deadline about 485 days).',
		changeNote:
			'After 240 days, VGLI asks health questions. It closes 1 year and 120 days after you leave.',
		afterNote:
			'The standard VGLI deadline (1 year and 120 days) has passed; see va.gov for life insurance options.'
	},
	{
		id: 'final-pay-check',
		title: 'Verify your final pay and terminal-leave settlement',
		category: 'finance',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: 0,
		windowEnd: 120,
		recommendedOffset: 30,
		why: 'Final-pay and leave sell-back errors are common and worth catching.'
	},
	{
		id: 'va-claim-fallback',
		title: 'File your VA disability claim (if you did not file through BDD)',
		category: 'benefits',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: 0,
		windowEnd: 365,
		recommendedOffset: 14,
		why: 'If you missed the BDD window: for a claim VA receives within 1 year of separation, the effective date can be as early as the day after you separate.'
	}
];
