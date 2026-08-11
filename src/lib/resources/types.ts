// The Resources page groups links by these browse categories; a resource has exactly one.
export type DisplayCategory =
	| 'benefits-va'
	| 'claims-vso'
	| 'employment'
	| 'education'
	| 'finance'
	| 'skillbridge-transition'
	| 'mentorship-networking'
	| 'health-wellbeing';

// A curated outbound link. `displayCategory` drives the browse page; `lastVerified` is the freshness
// stamp for the periodic manual re-check. Which links surface on a given timeline task is a curated
// per-task mapping (see TASK_RESOURCES), not a property of the resource.
export interface Resource {
	id: string;
	title: string;
	url: string;
	description: string;
	displayCategory: DisplayCategory;
	lastVerified: string; // ISO 8601 date (YYYY-MM-DD)
}
