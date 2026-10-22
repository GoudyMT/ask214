/**
 * One row as the site's Lookup endpoint returns it, before the pipeline cleans it. Field names and types are the
 * site's own, as measured on the 1,435-listing sample; nothing here is trusted, and most of it is never
 * published (see `Listing` for what is).
 */
export type ApiListing = {
	id: number;
	distance: number;
	branches: string[];
	ml: boolean;
	natSec: boolean;
	dib: boolean;
	organization: string;
	program: string;
	installation: string | null;
	city: string;
	state: string;
	zip: string | null;
	employerPoc: string;
	employerPocEmail: string;
	duration: string;
	summary: string;
	jobDescription: string;
	/** Comma-separated state codes, prose, or "ALL". */
	locationStates: string;
	targetMOCs: string;
	otherEligibilityFactors: string;
	other: string;
	moUs: boolean;
	lat: number;
	lon: number;
	deliveryMethodId: number;
	/** The official industry names joined by "; " or " and ", or prose. */
	industries: string;
	dateCreated: string;
	programId: number;
	organizationId: number;
	programType: string;
};
