/**
 * Synthetic rows in the site's own shape, for the pipeline's clean step and its tests. Every name, place and
 * address is made up and every email is at example.com: the shapes come from the 1,435-listing sample, the
 * values never do. Each bad case is one the sample really contained.
 */

import type { ApiListing } from '../contract/api';

const ZERO_WIDTH = String.fromCharCode(0x200b);
const PRIVATE_USE = String.fromCharCode(0xe000);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
const CURLY_APOSTROPHE = String.fromCharCode(0x2019);

/** A clean, ordinary in-person listing; each case below changes only what it is about. */
export function rawListing(overrides: Partial<ApiListing> = {}): ApiListing {
	return {
		id: 1001,
		distance: 0,
		branches: ['Navy', 'Army'],
		ml: false,
		natSec: false,
		dib: false,
		organization: 'Example Wind Services',
		program: 'Field Technician Internship',
		installation: '',
		city: 'Columbia',
		state: 'MD',
		zip: '21046',
		employerPoc: 'Pat Example',
		employerPocEmail: 'skillbridge@example.com',
		duration: '91 - 120 days',
		summary: 'A made-up summary that the pipeline must drop.',
		jobDescription: 'Field Technician, Wind Turbine Technician',
		locationStates: 'MD, VA',
		targetMOCs: '91B, 2A6X1, EM',
		otherEligibilityFactors: 'Made-up eligibility prose that must be dropped.',
		other: 'See https://forms.example.com/more for details.',
		moUs: true,
		lat: 39.2,
		lon: -76.86,
		deliveryMethodId: 1,
		industries: 'Installation, Maintenance, and Repair',
		dateCreated: '2026-07-24T00:00:00',
		programId: 501,
		organizationId: 301,
		programType: 'Internship Program',
		...overrides
	};
}

/** The measured bad shapes, one row each, keyed by what is wrong. */
export const RAW_CASES = {
	flippedLongitude: rawListing({ id: 1002, lon: 76.86 }),
	nullIsland: rawListing({ id: 1003, lat: 0, lon: 0 }),
	guamFiledUnderAlaska: rawListing({
		id: 1004,
		city: 'Hagatna',
		state: 'AK',
		zip: '96910',
		lat: 13.47,
		lon: 144.75
	}),
	virtualState: rawListing({
		id: 1005,
		state: 'Virtual',
		city: '',
		zip: null,
		deliveryMethodId: 2,
		locationStates: ''
	}),
	stateNA: rawListing({ id: 1006, state: 'NA' }),
	zipMissingLeadingZero: rawListing({
		id: 1007,
		city: 'Boston',
		state: 'MA',
		zip: '2134',
		lat: 42.35,
		lon: -71.13
	}),
	twoEmails: rawListing({ id: 1008, employerPocEmail: 'jobs@example.com; hr@example.com' }),
	urlAsEmail: rawListing({ id: 1009, employerPocEmail: 'https://forms.example.com/apply' }),
	httpUrlAsEmail: rawListing({ id: 1010, employerPocEmail: 'http://forms.example.com/apply' }),
	spacedEmail: rawListing({ id: 1011, employerPocEmail: ' jobs @example.com ' }),
	emailWithQuery: rawListing({
		id: 1012,
		employerPocEmail: 'jobs@example.com?subject=SkillBridge'
	}),
	tenPlusStates: rawListing({
		id: 1013,
		locationStates: 'AK, AL, AZ, CA, CO, FL, GA, HI, MD, NC, TX, VA, WA'
	}),
	allStates: rawListing({ id: 1014, locationStates: 'ALL' }),
	proseStates: rawListing({ id: 1015, locationStates: 'Nationwide, near most major bases' }),
	stateOutsideItsList: rawListing({ id: 1016, state: 'TX', locationStates: 'MD, VA' }),
	htmlInProgram: rawListing({ id: 1017, program: 'Field <b>Technician</b> Internship' }),
	zeroWidthInName: rawListing({
		id: 1018,
		organization: 'Example' + ZERO_WIDTH + ' Wind Services'
	}),
	privateUseInCity: rawListing({ id: 1019, city: 'Columbia' + PRIVATE_USE }),
	bidiOverride: rawListing({ id: 1020, program: RIGHT_TO_LEFT_OVERRIDE + 'Technician Internship' }),
	paddedName: rawListing({ id: 1021, organization: '  Example Wind Services ' }),
	curlyApostrophe: rawListing({
		id: 1022,
		organization: 'Example' + CURLY_APOSTROPHE + 's Wind Services'
	}),
	proseRoles: rawListing({
		id: 1023,
		jobDescription:
			'Participants will learn to: inspect turbines - and more, with hands-on work every day.'
	}),
	rolesWithParentheses: rawListing({
		id: 1024,
		jobDescription: 'Technician (Electrical, Mechanical), Inspector'
	}),
	allOccupations: rawListing({ id: 1025, targetMOCs: 'All MOCs' }),
	proseOccupations: rawListing({
		id: 1026,
		targetMOCs: 'Nurse, or Nursing Assistant, RN, LPN, CNA'
	}),
	codesWithNames: rawListing({
		id: 1027,
		targetMOCs: '91B (Light Wheel Mechanic), EM (Electricians Mate)'
	}),
	industryAlias: rawListing({ id: 1028, industries: 'Education, Training, and Library' }),
	industryOtherProse: rawListing({ id: 1029, industries: 'Other - renewable energy field work' }),
	industriesJoinedByAnd: rawListing({
		id: 1030,
		industries: 'Installation, Maintenance, and Repair and Construction and Extraction'
	}),
	noIndustry: rawListing({ id: 1031, industries: '' }),
	unknownBranches: rawListing({ id: 1032, branches: ['Unknown', ''] }),
	proseProgramType: rawListing({
		id: 1033,
		programType: '12-week training program for made-up technicians'
	}),
	emptyProgramType: rawListing({ id: 1034, programType: '' }),
	emptyDuration: rawListing({ id: 1035, duration: '' }),
	nullInstallation: rawListing({ id: 1036, installation: null }),
	longInstallation: rawListing({ id: 1037, installation: 'Made-up installation text '.repeat(12) }),
	territory: rawListing({
		id: 1038,
		city: 'San Juan',
		state: 'PR',
		zip: '00901',
		lat: 18.46,
		lon: -66.1,
		locationStates: 'PR'
	}),
	hybrid: rawListing({ id: 1039, deliveryMethodId: 3 }),
	// Same content as `rawListing()` under another id: the pipeline keeps the lowest id and aliases this one.
	duplicateContent: rawListing({ id: 1040 })
} satisfies Record<string, ApiListing>;
