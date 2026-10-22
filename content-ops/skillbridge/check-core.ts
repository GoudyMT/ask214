/**
 * The weekly check: decides what is published, what is only "not seen", what is removed, which listings are New,
 * and whether the week looks wrong enough to hold back. Pure: it takes the pull, the cleaned listings and last
 * week's state, and returns the verdict and the state to keep. Leaning toward keeping a listing: it is removed only
 * when the server itself proved it gone.
 */

import type { Listing } from '../../src/lib/skillbridge-finder/contract/listing.ts';
import { isIsoDate } from '../../src/lib/skillbridge-finder/contract/places.ts';
import { validateListing } from '../../src/lib/skillbridge-finder/contract/validate.ts';
import {
	DRIFT_LIMIT,
	NEW_WINDOW_DAYS,
	PROVIDER_FLOOR_MIN,
	PROVIDER_FLOOR_RATIO
} from './config.ts';
import type {
	CheckOutput,
	CleanOutput,
	LinksOutput,
	PipelineState,
	ProviderResult,
	PullRun,
	StateRecord
} from './types.ts';

const DAY_MS = 86_400_000;

export function emptyState(): PipelineState {
	return {
		v: 1,
		baselineDate: null,
		lastPullDate: null,
		records: {},
		knownOrgs: [],
		knownProviders: [],
		providerCounts: [],
		pinnedSites: [],
		suppression: [],
		lastWeek: null,
		nextMode: 'full'
	};
}

function utcDay(iso: string): number {
	const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
	return Date.UTC(y, m - 1, d);
}

/** Whole UTC days from one `YYYY-MM-DD` date to another: local time and clock changes cannot shift it. */
export function daysBetween(fromIso: string, toIso: string): number {
	return Math.round((utcDay(toIso) - utcDay(fromIso)) / DAY_MS);
}

/** A program created lately, or dated after the pull (a clock skew on the server), is new to the people reading. */
function createdLately(dc: string, pullDate: string): boolean {
	if (dc > pullDate) return true;
	const age = daysBetween(dc, pullDate);
	return age >= 0 && age <= NEW_WINDOW_DAYS;
}

const byNumber = (a: number, b: number) => a - b;

export function runCheck(input: {
	state: PipelineState;
	pull: PullRun;
	clean: CleanOutput;
	links: LinksOutput;
	pullDate: string;
	/** The first full pull, or a re-baseline: every listing's `fl` is this pull date and nothing is New. */
	baseline: boolean;
	/** Max read the report and accepts a drift past the limit. */
	acceptDrift: boolean;
}): CheckOutput {
	const { state, pull, clean, links, pullDate, baseline, acceptDrift } = input;

	const blockers: string[] = [];
	const block = (code: string) => {
		if (!blockers.includes(code)) blockers.push(code);
	};
	if (!isIsoDate(pullDate)) block('E_BAD_PULL_DATE');
	if (state.lastPullDate !== null && pullDate <= state.lastPullDate) block('E_PULL_DATE_ORDER');
	if (!baseline && state.baselineDate === null) block('E_NO_BASELINE');

	// A listing is credited to the first provider whose query returned it; a provider renamed on the server
	// returns its listings under the new name, so they are seen there and never counted as gone.
	const providerOf = new Map<number, string>();
	const providerByName = new Map<string, ProviderResult>();
	for (const p of pull.providers) {
		if (!providerByName.has(p.name)) providerByName.set(p.name, p);
		for (const id of p.ids) if (!providerOf.has(id)) providerOf.set(id, p.name);
	}

	const seenIds = new Set(clean.listings.map((l) => l.i));
	const mergedIds = new Set(clean.aliases.map(([merged]) => merged));
	const overseasIds = new Set(clean.overseas);
	const suppressed = new Set(state.suppression);
	// An id some provider returned this week is alive, even when the clean step set its row aside.
	const returnedIds = new Set(pull.providers.flatMap((p) => p.ids));
	const filtersNames = new Set(pull.filtersProviders);
	const everyProviderComplete = pull.providers.every((p) => p.complete);

	// A baseline replaces the earlier records, so it must not silently drop live listings.
	if (
		baseline &&
		Object.keys(state.records).length > 0 &&
		(!pull.sumGate || !everyProviderComplete) &&
		!acceptDrift
	)
		block('E_BASELINE_UNPROVEN');
	const orgLinks = new Map(links.byOrg);
	const knownOrgs = new Set(state.knownOrgs);

	const published: Listing[] = [];
	const records: Record<string, StateRecord> = {};
	const added: number[] = [];
	const removed: number[] = [];
	const notSeen: number[] = [];
	const seenOrgs = new Set<number>();
	let firstSightings = 0;

	for (const row of clean.listings) {
		const key = String(row.i);
		const prior = baseline ? undefined : state.records[key];
		let fl: string;
		if (baseline) fl = pullDate;
		else if (prior !== undefined) fl = prior.listing.fl;
		else {
			firstSightings++;
			if (createdLately(row.dc, pullDate)) {
				fl = pullDate;
				added.push(row.i);
			} else fl = state.baselineDate ?? pullDate;
		}

		// The site's clock can run ahead of ours; a creation date after the pull would be refused by the app.
		const listing: Listing = { ...row, dc: row.dc > pullDate ? pullDate : row.dc, fl };
		const found = orgLinks.get(row.o);
		if (found?.w !== undefined) listing.w = found.w;
		if (found?.li !== undefined) listing.li = found.li;

		published.push(listing);
		seenOrgs.add(row.o);
		records[key] = {
			listing,
			provider: providerOf.get(row.i) ?? prior?.provider ?? '',
			misses: 0,
			...(overseasIds.has(row.i) ? { overseas: true } : {})
		};
	}

	if (!baseline) {
		for (const [key, rec] of Object.entries(state.records)) {
			const id = rec.listing.i;
			if (seenIds.has(id) || mergedIds.has(id)) continue;
			// Gone only when the pull's totals add up, no provider returned it, and the provider that last
			// returned it was fully read without it. A provider not queried proves nothing, and a name missing
			// from Filters proves nothing while another provider is unread: the listing may have moved to it.
			// A full pull in which every provider was read to the end and the totals add up accounted for all the
			// listings there are, so an id none of them returned is gone whatever provider it was recorded under
			// (a listing saved from a snapshot has none).
			const fullPullAccountedForAll =
				pull.mode === 'full' && pull.providers.length > 0 && everyProviderComplete;
			if (
				pull.sumGate &&
				!returnedIds.has(id) &&
				(fullPullAccountedForAll ||
					(providerByName.get(rec.provider)?.complete === true &&
						(filtersNames.has(rec.provider) || everyProviderComplete)))
			) {
				removed.push(id);
				continue;
			}
			const kept = structuredClone(rec.listing);
			// A kept copy is published again, so a contact removed on request since it was recorded goes now.
			if (kept.e !== undefined && suppressed.has(kept.e.toLowerCase())) delete kept.e;
			notSeen.push(id);
			published.push(kept);
			records[key] = {
				listing: kept,
				provider: rec.provider,
				misses: rec.misses + 1,
				...(rec.overseas === true ? { overseas: true } : {})
			};
		}
	}

	const lastCount = Object.keys(state.records).length;
	let driftAbort = false;
	if (!baseline && state.lastPullDate !== null && lastCount > 0) {
		const past = DRIFT_LIMIT * lastCount;
		if (firstSightings > past || removed.length > past) {
			driftAbort = !acceptDrift;
			if (driftAbort) block('E_DRIFT');
		}
	}

	const floorWarnings: CheckOutput['floorWarnings'] = [];
	for (const [name, last] of state.providerCounts) {
		const now = providerByName.get(name)?.ids.length;
		if (now === undefined || last < PROVIDER_FLOOR_MIN) continue;
		if (now < last * PROVIDER_FLOOR_RATIO) floorWarnings.push({ provider: name, last, now });
	}

	if (published.some((l) => validateListing(l).length > 0)) block('E_INVALID_LISTING');

	published.sort((a, b) => a.i - b.i);
	const week = {
		pullDate,
		added: added.sort(byNumber),
		removed: removed.sort(byNumber),
		newOrgs: baseline ? [] : [...seenOrgs].filter((o) => !knownOrgs.has(o)).sort(byNumber)
	};

	return {
		published,
		week,
		notSeen: notSeen.sort(byNumber),
		removed: week.removed,
		floorWarnings,
		driftAbort,
		blockers,
		nextState: {
			v: 1,
			baselineDate: baseline ? pullDate : state.baselineDate,
			lastPullDate: pullDate,
			records,
			knownOrgs: [...new Set([...state.knownOrgs, ...seenOrgs])].sort(byNumber),
			knownProviders: [...pull.filtersProviders],
			providerCounts: pull.providers.map((p) => [p.name, p.ids.length]),
			pinnedSites: links.pinned.map(([org, url]) => [org, url]),
			suppression: [...state.suppression],
			lastWeek: week,
			nextMode: pull.nextMode
		}
	};
}
