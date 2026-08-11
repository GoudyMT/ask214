import type { Resource } from './types';

// The curated outbound link set. Claims and benefits links go only to official .gov (va.gov) or a
// VA-accredited veterans service organization, per the 38 CFR 14.629 boundary; other categories may
// include official government programs and vetted national nonprofits. Descriptions are informational
// and never assert personal eligibility. Each url is verified against the live official source on its
// lastVerified date; re-verify the whole set about every 6 months. Grouped by displayCategory.
export const RESOURCES: readonly Resource[] = [
	// Benefits & VA
	{
		id: 'va-home',
		title: 'VA.gov',
		url: 'https://www.va.gov',
		description: 'The VA hub for health care, benefits, and services.',
		displayCategory: 'benefits-va',
		lastVerified: '2026-08-09'
	},
	{
		id: 'va-disability',
		title: 'VA Disability Compensation',
		url: 'https://www.va.gov/disability/',
		description: 'Official information on VA disability compensation and how to file.',
		displayCategory: 'benefits-va',
		lastVerified: '2026-08-09'
	},
	{
		id: 'va-welcome-kit',
		title: 'VA Welcome Kit',
		url: 'https://www.va.gov/welcome-kit/',
		description: 'Step-by-step guides to the VA benefits and services available after separation.',
		displayCategory: 'benefits-va',
		lastVerified: '2026-08-09'
	},

	// Claims filing (VSO)
	{
		id: 'va-accredited-rep',
		title: 'Find a VA-Accredited Representative',
		url: 'https://www.va.gov/get-help-from-accredited-representative/',
		description:
			'Official VA search to connect with an accredited VSO representative for claims help; VSO claim help is free.',
		displayCategory: 'claims-vso',
		lastVerified: '2026-08-09'
	},
	{
		id: 'dav',
		title: 'Disabled American Veterans (DAV)',
		url: 'https://www.dav.org',
		description:
			'A VA-accredited veterans service organization offering free help filing VA claims.',
		displayCategory: 'claims-vso',
		lastVerified: '2026-08-09'
	},
	{
		id: 'vfw',
		title: 'Veterans of Foreign Wars (VFW)',
		url: 'https://www.vfw.org',
		description: 'A VA-accredited veterans service organization offering free claims assistance.',
		displayCategory: 'claims-vso',
		lastVerified: '2026-08-09'
	},
	{
		id: 'american-legion',
		title: 'The American Legion',
		url: 'https://www.legion.org',
		description: 'A VA-accredited veterans service organization offering free VA claims help.',
		displayCategory: 'claims-vso',
		lastVerified: '2026-08-09'
	},

	// Employment
	{
		id: 'usajobs',
		title: 'USAJOBS',
		url: 'https://www.usajobs.gov',
		description: "The federal government's official job site.",
		displayCategory: 'employment',
		lastVerified: '2026-08-09'
	},
	{
		id: 'dol-vets',
		title: 'DOL VETS',
		url: 'https://www.dol.gov/agencies/vets',
		description: "The Department of Labor's Veterans' Employment and Training Service.",
		displayCategory: 'employment',
		lastVerified: '2026-08-09'
	},
	{
		id: 'careeronestop',
		title: 'CareerOneStop',
		url: 'https://www.careeronestop.org',
		description: 'DOL-sponsored career, training, and job-search tools, with a veterans section.',
		displayCategory: 'employment',
		lastVerified: '2026-08-09'
	},
	{
		id: 'hiring-our-heroes',
		title: 'Hiring Our Heroes',
		url: 'https://www.hiringourheroes.org',
		description:
			'A US Chamber of Commerce Foundation program connecting service members and veterans with employers.',
		displayCategory: 'employment',
		lastVerified: '2026-08-09'
	},
	{
		id: 'linkedin-veterans',
		title: 'LinkedIn for Veterans',
		url: 'https://socialimpact.linkedin.com/programs/veterans',
		description:
			'A free year of LinkedIn Premium for eligible service members and veterans, redeemed through partner veteran nonprofits.',
		displayCategory: 'employment',
		lastVerified: '2026-08-09'
	},

	// Education
	{
		id: 'gi-bill',
		title: 'GI Bill',
		url: 'https://www.va.gov/education/',
		description: 'Official overview of VA education benefits, including the Post-9/11 GI Bill.',
		displayCategory: 'education',
		lastVerified: '2026-08-09'
	},
	{
		id: 'gi-bill-comparison',
		title: 'GI Bill Comparison Tool',
		url: 'https://www.va.gov/education/gi-bill-comparison-tool/',
		description: 'Compare approved schools and training programs by benefits, cost, and outcomes.',
		displayCategory: 'education',
		lastVerified: '2026-08-09'
	},
	{
		id: 'vre',
		title: 'Veteran Readiness & Employment (Chapter 31)',
		url: 'https://www.va.gov/careers-employment/vocational-rehabilitation/',
		description:
			'A VA program for veterans with service-connected disabilities to prepare for and find work.',
		displayCategory: 'education',
		lastVerified: '2026-08-09'
	},
	{
		id: 'vet-tec',
		title: 'VET TEC 2.0',
		url: 'https://www.va.gov/education/other-va-education-benefits/vet-tec-2/',
		description: 'A VA program funding non-degree high-tech training such as coding, IT, and data.',
		displayCategory: 'education',
		lastVerified: '2026-08-09'
	},

	// Finance
	{
		id: 'tsp',
		title: 'Thrift Savings Plan (TSP)',
		url: 'https://www.tsp.gov',
		description:
			'The official federal retirement savings plan; manage your account after separation.',
		displayCategory: 'finance',
		lastVerified: '2026-08-09'
	},
	{
		id: 'vgli',
		title: "Veterans' Group Life Insurance (VGLI)",
		url: 'https://www.va.gov/life-insurance/options-eligibility/vgli/',
		description: 'Official information on converting SGLI to VGLI after leaving service.',
		displayCategory: 'finance',
		lastVerified: '2026-08-09'
	},
	{
		id: 'mos-financial',
		title: 'Military OneSource: Financial Counseling',
		url: 'https://www.militaryonesource.mil/benefits/financial-counseling/',
		description: 'Free financial counseling for service members and recently separated veterans.',
		displayCategory: 'finance',
		lastVerified: '2026-08-09'
	},

	// SkillBridge & Transition
	{
		id: 'skillbridge',
		title: 'DoD SkillBridge',
		url: 'https://www.skillbridge.mil',
		description:
			'The DoD program for civilian job training and internships during your last 180 days of service.',
		displayCategory: 'skillbridge-transition',
		lastVerified: '2026-08-10'
	},
	{
		id: 'dodtap',
		title: 'DoD Transition Assistance Program (TAP)',
		url: 'https://www.dodtap.mil',
		description: 'The official DoD Transition Assistance Program portal.',
		displayCategory: 'skillbridge-transition',
		lastVerified: '2026-08-09'
	},
	{
		id: 'military-onesource',
		title: 'Military OneSource',
		url: 'https://www.militaryonesource.mil',
		description: "DoD's 24/7 hub for transition, relocation, and family resources.",
		displayCategory: 'skillbridge-transition',
		lastVerified: '2026-08-09'
	},
	{
		id: 'navy-transition',
		title: 'Navy Fleet & Family Support: Transition Assistance',
		url: 'https://ffr.cnic.navy.mil/Family-Readiness/Fleet-And-Family-Support-Program/Work-and-Family-Life/Transition-Assistance/',
		description: "The Navy's transition assistance program through Fleet and Family Support.",
		displayCategory: 'skillbridge-transition',
		lastVerified: '2026-08-09'
	},

	// Mentorship & Networking
	{
		id: 'acp',
		title: 'American Corporate Partners (ACP)',
		url: 'https://www.acp-usa.org',
		description:
			'Free yearlong one-on-one mentoring with corporate professionals for post-9/11 veterans and military spouses.',
		displayCategory: 'mentorship-networking',
		lastVerified: '2026-08-09'
	},
	{
		id: 'milmentor',
		title: 'MilMentor',
		url: 'https://www.milmentor.com',
		description:
			'A free, on-demand mentorship platform for veterans, transitioning service members, and military spouses.',
		displayCategory: 'mentorship-networking',
		lastVerified: '2026-08-09'
	},
	{
		id: 'hire-heroes',
		title: 'Hire Heroes USA',
		url: 'https://www.hireheroesusa.org',
		description:
			'Free personalized career coaching, resume help, and a job board for the military community.',
		displayCategory: 'mentorship-networking',
		lastVerified: '2026-08-09'
	},

	// Health & Wellbeing
	{
		id: 'crisis-line',
		title: 'Veterans Crisis Line',
		url: 'https://www.veteranscrisisline.net',
		description: 'Free, confidential crisis support, 24/7. Dial 988 then press 1.',
		displayCategory: 'health-wellbeing',
		lastVerified: '2026-08-09'
	},
	{
		id: 'va-health',
		title: 'VA Health Care',
		url: 'https://www.va.gov/health-care/',
		description: 'Apply for and manage VA health care after you separate.',
		displayCategory: 'health-wellbeing',
		lastVerified: '2026-08-09'
	},
	{
		id: 'va-mental-health',
		title: 'VA Mental Health',
		url: 'https://www.mentalhealth.va.gov',
		description: 'VA mental health services and resources.',
		displayCategory: 'health-wellbeing',
		lastVerified: '2026-08-09'
	}
];

// Curated per-task relevance: each timeline task maps to only the resources that genuinely help it (a
// human-judged pass, not a category dump). Tasks absent here surface nothing. Keys are timeline task ids
// (src/lib/timeline/task-defs.ts); values are resource ids, in the order to show them.
export const TASK_RESOURCES: Record<string, readonly string[]> = {
	'va-gov-account': ['va-home'],
	'will-poa': ['military-onesource'],
	'financial-counselor': ['mos-financial'],
	'master-resume': ['hire-heroes', 'careeronestop', 'linkedin-veterans'],
	'gi-bill-research': ['gi-bill', 'gi-bill-comparison', 'vet-tec'],
	'document-medical': ['va-disability'],
	'preseparation-counseling': ['dodtap', 'navy-transition'],
	'tap-course': ['dodtap', 'dol-vets'],
	'tap-track': ['dodtap'],
	'job-search': ['usajobs', 'hiring-our-heroes', 'hire-heroes'],
	'health-insurance-research': ['military-onesource'],
	'life-insurance-research': ['vgli', 'mos-financial'],
	'va-career-guidance': ['acp', 'milmentor'],
	'jst-order': ['military-onesource'],
	'school-apply': ['gi-bill-comparison', 'gi-bill'],
	'va-bdd-claim': ['va-disability', 'va-accredited-rep'],
	'tap-capstone': ['dodtap'],
	'va-benefits-advisor': ['va-accredited-rep', 'va-welcome-kit'],
	'hhg-counseling': ['military-onesource'],
	'separation-package': ['navy-transition'],
	'tricare-elect': ['military-onesource'],
	'tsp-decision': ['tsp'],
	'vgli-convert': ['vgli'],
	'va-claim-fallback': ['va-disability', 'va-accredited-rep']
};
