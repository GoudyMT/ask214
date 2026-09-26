import type { TaskDef, PhaseBucket } from './types';

/**
 * Phase buckets for the timeline view: the 24-month runway, furthest-out first.
 * A task is grouped into the bucket whose [startOffset, endOffset) contains its
 * recommendedOffset; empty buckets are dropped at render (generation).
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
 * current DoD/VA/DoL/Navy sources (2024-2026). Timing is the BASELINE (no-SkillBridge)
 * path anchored to EAOS; the generation engine applies the SkillBridge shift to
 * `track: 'military'` tasks when the profile has SkillBridge approved.
 *
 * `track`: 'military' = must finish on the military side (shifts with SkillBridge);
 * 'transition' = anchored to the real EAOS / VA process. Tasks with no authoritative
 * fixed date use a wide early window (best-practice prep). `requires` gates a task on a
 * persona field (hidden until set + matched).
 *
 * Authored and confirmed from lived Navy-ETS experience, backed by a research pass.
 */
export const TASK_DEFS: readonly TaskDef[] = [
	// ---- Early prep (no authoritative fixed date; recommended 18-24 months out) ----
	{
		id: 'va-gov-account',
		title: 'Create your VA.gov account',
		category: 'admin',
		track: 'transition',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'Your VA.gov account is the gateway to claims, health care, and records.'
	},
	{
		id: 'login-gov-account',
		title: 'Create your Login.gov account',
		category: 'admin',
		track: 'transition',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'Login.gov is the secure sign-in for VA.gov and other federal services.'
	},
	{
		id: 'update-sgli',
		title: 'Review your SGLI coverage and beneficiaries',
		category: 'finance',
		track: 'military',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'Coverage amounts and beneficiaries drift out of date.'
	},
	{
		id: 'verify-service-record',
		title: 'Verify your service record is accurate (awards, training)',
		category: 'admin',
		track: 'military',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'Record errors are far easier to fix while you are still in.'
	},
	{
		id: 'will-poa',
		title: 'Create a will and power of attorney',
		category: 'admin',
		track: 'transition',
		windowStart: -730,
		windowEnd: -90,
		recommendedOffset: -540,
		why: 'Legal documents take time and are easy to put off.'
	},
	{
		id: 'financial-counselor',
		title: 'Meet a personal financial counselor',
		category: 'finance',
		track: 'transition',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'A transition changes your pay, benefits, and budget.'
	},
	{
		id: 'master-resume',
		title: 'Create a master resume',
		category: 'career',
		track: 'transition',
		windowStart: -540,
		windowEnd: -120,
		recommendedOffset: -450,
		why: 'Translating military experience into civilian terms takes several drafts.'
	},
	{
		id: 'gi-bill-research',
		title: 'Research your GI Bill and education options',
		category: 'benefits',
		track: 'transition',
		windowStart: -730,
		windowEnd: -180,
		recommendedOffset: -540,
		why: 'Education benefits and school timelines take months to line up.'
	},
	{
		id: 'document-medical',
		title: 'Start documenting any medical conditions',
		category: 'medical',
		track: 'military',
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
		track: 'military',
		windowStart: -540,
		windowEnd: -365,
		recommendedOffset: -400,
		why: 'TAP officially starts here, and it is required no later than 365 days out.'
	},
	{
		id: 'tap-course',
		title: 'Attend your required TAP curriculum',
		category: 'admin',
		track: 'military',
		windowStart: -365,
		windowEnd: -120,
		recommendedOffset: -270,
		why: 'The DoL Employment Workshop and VA Benefits Briefings I and II are mandatory.'
	},
	{
		id: 'tap-track',
		title: 'Attend a TAP 2-day track (Employment / Education / Vocational / Entrepreneurship)',
		category: 'admin',
		track: 'military',
		windowStart: -365,
		windowEnd: -120,
		recommendedOffset: -240,
		why: 'Each member picks one focused 2-day track for their path.'
	},

	// ---- Job / benefits prep (mid window) ----
	{
		id: 'job-search',
		title: 'Begin and refine your job search',
		category: 'career',
		track: 'transition',
		windowStart: -365,
		windowEnd: -30,
		recommendedOffset: -270,
		why: 'Job searches take months from first application to offer.'
	},
	{
		id: 'health-insurance-research',
		title: 'Research your health-coverage options (TRICARE/TAMP, civilian)',
		category: 'benefits',
		track: 'transition',
		windowStart: -365,
		windowEnd: -90,
		recommendedOffset: -270,
		why: 'Coverage can lapse the day you separate if you do not plan.'
	},
	{
		id: 'life-insurance-research',
		title: 'Research life-insurance options for you and your family',
		category: 'benefits',
		track: 'transition',
		windowStart: -365,
		windowEnd: -90,
		recommendedOffset: -270,
		why: 'SGLI ends after separation; VGLI and civilian options differ in cost and coverage.'
	},
	{
		id: 'va-career-guidance',
		title: 'Apply for VA personalized career planning and guidance',
		category: 'career',
		track: 'transition',
		windowStart: -365,
		windowEnd: -90,
		recommendedOffset: -240,
		why: 'VA offers free career counseling (Chapter 36) to map your path.'
	},
	{
		id: 'jst-order',
		title: 'Order your Joint Services Transcript (JST)',
		category: 'career',
		track: 'transition',
		windowStart: -180,
		windowEnd: -90,
		recommendedOffset: -150,
		why: 'Schools and employers use your JST to credit your military training.'
	},
	{
		id: 'reserve-affiliation',
		title: 'Start reserve affiliation',
		category: 'career',
		track: 'transition',
		windowStart: -300,
		windowEnd: -90,
		recommendedOffset: -180,
		why: 'Affiliating with the reserves takes paperwork and lead time.',
		requires: { intendedPath: ['reserves'] }
	},
	{
		id: 'school-apply',
		title: 'Apply to schools and submit the FAFSA',
		category: 'benefits',
		track: 'transition',
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
		track: 'military',
		windowStart: -180,
		windowEnd: -90,
		recommendedOffset: -150,
		why: 'The SHA is one exam that serves both your separation and your VA claim - book it early.'
	},
	{
		id: 'sha-complete',
		title: 'Complete your SHA (physical, dental, audiogram) and the Part A self-assessment',
		category: 'medical',
		track: 'military',
		windowStart: -150,
		windowEnd: -90,
		recommendedOffset: -120,
		why: 'Part A is the self-assessment your VA (BDD) claim is built on.'
	},
	{
		id: 'va-bdd-claim',
		title: 'File your VA disability claim through BDD (Benefits Delivery at Discharge)',
		category: 'benefits',
		track: 'transition',
		windowStart: -180,
		windowEnd: -90,
		recommendedOffset: -120,
		why: 'Filing 180-90 days out is the fastest path and often decides your claim near separation; you must be available for VA exams within 45 days.'
	},

	// ---- Capstone + final-90 ----
	{
		id: 'tap-capstone',
		title: 'Complete your TAP Capstone',
		category: 'admin',
		track: 'military',
		windowStart: -120,
		windowEnd: -90,
		recommendedOffset: -90,
		why: 'Your commander verifies you meet Career Readiness Standards no later than 90 days out.'
	},
	{
		id: 'va-benefits-advisor',
		title: 'Meet one-on-one with a VA benefits advisor',
		category: 'benefits',
		track: 'transition',
		windowStart: -180,
		windowEnd: -60,
		recommendedOffset: -120,
		why: 'A benefits advisor helps you claim everything you earned.'
	},
	{
		id: 'reference-letters',
		title: 'Gather reference and recommendation letters',
		category: 'career',
		track: 'transition',
		windowStart: -180,
		windowEnd: -30,
		recommendedOffset: -120,
		why: 'Ask while your work is fresh and your leaders are still available.'
	},
	{
		id: 'financial-docs',
		title: 'Save your LES history, myPay access, and SGLI election',
		category: 'finance',
		track: 'military',
		windowStart: -120,
		windowEnd: -30,
		recommendedOffset: -90,
		why: 'You lose easy access to military pay records after you separate.'
	},
	{
		id: 'hhg-counseling',
		title: 'Arrange your household-goods (HHG) move counseling',
		category: 'admin',
		track: 'military',
		windowStart: -180,
		windowEnd: -30,
		recommendedOffset: -120,
		why: 'Your final move is government-funded but must be scheduled.'
	},
	{
		id: 'separation-package',
		title: 'Submit your Navy separation package (1306, eval, award, statement of service)',
		category: 'admin',
		track: 'military',
		windowStart: -120,
		windowEnd: -60,
		recommendedOffset: -75,
		why: 'The Navy needs your package by about 60 days out to process your separation and DD-214.'
	},
	{
		id: 'dd214-review',
		title: 'Review your DD-2648 and DD-214 for accuracy',
		category: 'admin',
		track: 'military',
		windowStart: -90,
		windowEnd: -1,
		recommendedOffset: -30,
		why: 'Errors on the DD-214 are hard to correct after you separate.'
	},

	// ---- Near / at separation ----
	{
		id: 'tricare-elect',
		title: 'Elect your health-coverage transition (TRICARE/TAMP or civilian)',
		category: 'benefits',
		track: 'transition',
		windowStart: -60,
		windowEnd: 30,
		recommendedOffset: -14,
		why: 'Make the election before you separate to avoid a coverage gap.'
	},
	{
		id: 'dd214-copies',
		title: 'Make several certified copies of your DD-214 (member-4)',
		category: 'admin',
		track: 'transition',
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
		track: 'transition',
		windowStart: 0,
		windowEnd: 90,
		recommendedOffset: 30,
		why: 'An unpaid TSP loan becomes a taxable distribution after 90 days.'
	},
	{
		id: 'vgli-convert',
		title: 'Convert your SGLI to VGLI',
		category: 'benefits',
		track: 'transition',
		windowStart: 0,
		windowEnd: 240,
		recommendedOffset: 30,
		why: 'You can convert with no health questions within 240 days of separation (hard deadline about 485 days).'
	},
	{
		id: 'final-pay-check',
		title: 'Verify your final pay and terminal-leave settlement',
		category: 'finance',
		track: 'transition',
		windowStart: 0,
		windowEnd: 120,
		recommendedOffset: 30,
		why: 'Final-pay and leave sell-back errors are common and worth catching.'
	},
	{
		id: 'va-claim-fallback',
		title: 'File your VA disability claim (if you did not file through BDD)',
		category: 'benefits',
		track: 'transition',
		windowStart: 0,
		windowEnd: 180,
		recommendedOffset: 14,
		why: 'If you missed the BDD window, file now - an Intent-to-File locks your effective date.'
	}
];
