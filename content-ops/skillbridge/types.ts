/**
 * The shapes passed between the weekly pipeline's steps (pull -> clean -> links -> check -> layout -> report) and
 * the state it keeps between weeks. The published shapes live in the app's contract
 * (`src/lib/skillbridge-finder/contract/`); these never leave Max's PC.
 */

import type { ApiListing } from '../../src/lib/skillbridge-finder/contract/api.ts';
import type { ChangesFile, Listing } from '../../src/lib/skillbridge-finder/contract/listing.ts';

/** The Lookup endpoint's reply, as measured; nothing in it is trusted until checked. */
export type LookupResponse = {
	draw?: number;
	/** The true size of the query, even past the cap. */
	recordsTotal: number;
	/** The rows the server will return for it: never above the cap. */
	recordsFiltered: number;
	data: ApiListing[];
};

/**
 * The Filters endpoint's reply, as measured: about 6,600 provider names (sent back byte for byte, never trimmed),
 * 57 state values (including `NI` and `OS`, which are not states), 24 industries, 6 branches. `totalPositions`
 * arrives as a string.
 */
export type FiltersResponse = {
	providers: string[];
	states: string[];
	industries: string[];
	branches: string[];
	meta: { totalPositions: string };
	dib?: boolean;
};

/** `full` queries every provider; `weekly` queries last week's and new ones, and sweeps the rest when short. */
export type PullMode = 'full' | 'weekly';

/** Why a run stopped. On any of them nothing is publishable and the deployed week stays as it is. */
export type StopCode =
	| 'E_ROBOTS_DISALLOW'
	| 'E_ROBOTS_UNREADABLE'
	| 'E_HTTP_403'
	| 'E_HTTP_429'
	| 'E_HTML_BODY'
	| 'E_NOT_JSON'
	| 'E_BAD_ENVELOPE'
	| 'E_BAD_PROVIDER_NAME'
	| 'E_ERRORS_IN_A_ROW';

/** What the pull learned about one provider this run. */
export type ProviderResult = {
	/** Byte for byte as sent. */
	name: string;
	/** `recordsTotal` of its national query. */
	total: number;
	/** Every unique listing id its queries returned. */
	ids: number[];
	/** True only when `ids` reached `total`: then a listing of it missing from `ids` is really gone. */
	complete: boolean;
	/** Its queries still at the cap after every split; reported. */
	cappedQueries: number;
};

/** What the pull is told before it starts. */
export type PullInput = {
	mode: PullMode;
	/** The pull date, `YYYY-MM-DD`. */
	pullDate: string;
	/** Providers of every listing published now (seen or not seen): always queried, in both modes. */
	publishedProviders: string[];
	/** Every provider name seen in last week's Filters; a name not in it is new and is queried. */
	knownProviders: string[];
};

export type PullRun = {
	mode: PullMode;
	pullDate: string;
	/** `recordsTotal` of the query with no filter. */
	totalN: number;
	/** The Filters `meta.totalPositions`, as a number. */
	totalPositions: number;
	/** The Filters provider list as received. */
	filtersProviders: string[];
	/** Unique by id; the first row seen for an id is kept. */
	rows: ApiListing[];
	providers: ProviderResult[];
	/** The sum of every queried provider's `total`. */
	sumOfTotals: number;
	/** True when `sumOfTotals === totalN`; false means some listing is unaccounted for. */
	sumGate: boolean;
	/** True when a weekly run fell short of N and swept the dormant providers too. */
	dormantSwept: boolean;
	/** `full` whenever the sum gate failed. */
	nextMode: PullMode;
	requests: number;
	elapsedMs: number;
};

export type PullOutcome =
	| { ok: true; run: PullRun }
	| {
			ok: false;
			stop: StopCode;
			requests: number;
			elapsedMs: number;
			/** The path of the request in flight when the run stopped; never its query, which names a provider. */
			stoppedAt?: string;
	  };

/** A cleaned listing before the check step sets its first-listed date and the links step its links. */
export type CleanListing = Omit<Listing, 'fl' | 'w' | 'li'>;

export type CleanOutput = {
	listings: CleanListing[];
	/** `[merged id, kept id]`: same content under two ids; the lowest id is kept. */
	aliases: [number, number][];
	/** Rows not published, each with a static reason code; the raw value never appears. */
	quarantine: { id: number; code: string }[];
	/** Optional values dropped, counted by reason code. */
	dropped: Record<string, number>;
	/** Ids whose raw state named an overseas location (`OS`): published in the `overseas` file. */
	overseas: number[];
};

/** The links confirmed for one organization. */
export type OrgLinks = { w?: string; li?: string };

export type LinksOutput = {
	/** `[organization id, links]` for every organization with at least one confirmed link. */
	byOrg: [number, OrgLinks][];
	/** `[organization id, https home page]` confirmed now or before; kept in the state. */
	pinned: [number, string][];
	requests: number;
};

/** One published listing as the state remembers it. */
export type StateRecord = {
	listing: Listing;
	/** The provider whose query last returned it. */
	provider: string;
	/** Runs in a row it was not seen while its provider was not proven complete. */
	misses: number;
	/**
	 * Its raw state named an overseas location. A published listing cannot carry this (the overseas hint is not a
	 * state), so a week that keeps it without seeing it still needs it to file the listing under `overseas`.
	 */
	overseas?: boolean;
};

/** Everything the pipeline keeps between weeks, in a folder outside the repo. */
export type PipelineState = {
	v: 1;
	/** Null before the first baseline. */
	baselineDate: string | null;
	lastPullDate: string | null;
	/** Keyed by listing id. */
	records: Record<string, StateRecord>;
	/** Every organization id ever published. */
	knownOrgs: number[];
	/** Every provider name in the last Filters reply. */
	knownProviders: string[];
	/** `[provider, ids seen]` last run, for the per-provider floor. */
	providerCounts: [string, number][];
	pinnedSites: [number, string][];
	/** Contact addresses removed on request, lowercased; never published again. */
	suppression: string[];
	/** Last run's published change week, carried so two weeks are published. */
	lastWeek: ChangesFile['weeks'][number] | null;
	/** The mode the next run uses. */
	nextMode: PullMode;
};

/** What the check step decided this run. */
export type CheckOutput = {
	/** Everything to publish: seen listings with their links and first-listed dates, plus not-seen ones kept. */
	published: Listing[];
	/** This run's change week. */
	week: ChangesFile['weeks'][number];
	/** Ids kept from their last record because their provider was not proven complete. */
	notSeen: number[];
	removed: number[];
	/** Providers whose count fell past the floor. */
	floorWarnings: { provider: string; last: number; now: number }[];
	/** True when additions or removals passed the drift limit and were not accepted: nothing publishes. */
	driftAbort: boolean;
	/** Static codes for every reason the publish must not go ahead (validation, drift). */
	blockers: string[];
	nextState: PipelineState;
};
