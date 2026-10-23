import {
	DELIVERY,
	type Branch,
	type Delivery,
	type Duration,
	type Kind,
	type Listing
} from '../contract/listing';
import { STATE_NAMES } from '../search/state-names';
import type { FinderFilters, FinderRadius, FinderSetup } from '../state/types';

/** The words the list and its filter sheet use for the contract's values. */

export const FORMAT_LABELS: Record<Delivery, string> = {
	[DELIVERY.inPerson]: 'In person',
	[DELIVERY.remote]: 'Online',
	[DELIVERY.hybrid]: 'Hybrid'
};

/** The sheet lists the formats in the order a person thinks of them, not by the site's numbers. */
export const FORMAT_ORDER: readonly Delivery[] = [
	DELIVERY.inPerson,
	DELIVERY.hybrid,
	DELIVERY.remote
];

export const BRANCH_ORDER: readonly Branch[] = [
	'Army',
	'Navy',
	'Air Force',
	'Marine Corps',
	'Coast Guard',
	'Space Force'
];

export const KIND_LABELS: Record<Kind, string> = {
	internship: 'Internship',
	'job-training': 'Job training',
	'skills-training': 'Skills training',
	apprenticeship: 'Apprenticeship',
	fellowship: 'Fellowship',
	other: 'Other'
};

/** The site's seven length buckets are shown as four, which is what a person decides between. */
export const LENGTH_BUCKETS: readonly { label: string; durations: readonly Duration[] }[] = [
	{ label: 'Up to 60 days', durations: ['1-30', '31-60'] },
	{ label: '61-120 days', durations: ['61-90', '91-120'] },
	{ label: '121-180 days', durations: ['121-150', '151-180'] },
	{ label: 'Over 180 days', durations: ['180+'] }
];

export type Chip = { id: string; label: string };

export function placeChipLabel(setup: FinderSetup): string | null {
	const place = setup.place;
	if (place === undefined) return null;
	if (place.kind === 'state') return `In ${STATE_NAMES[place.state]}`;
	if (setup.radius === undefined) return `Near ${place.zip}`;
	return `Near ${place.zip} - ${setup.radius === 'any' ? 'any distance' : `${setup.radius} mi`}`;
}

/** One chip per active choice: the place, then each format, field, branch, length and kind. */
export function chipsOf(setup: FinderSetup, filters: FinderFilters): Chip[] {
	const chips: Chip[] = [];
	const place = placeChipLabel(setup);
	if (place !== null) chips.push({ id: 'place', label: place });
	for (const d of FORMAT_ORDER) {
		if (filters.delivery?.includes(d)) chips.push({ id: `delivery:${d}`, label: FORMAT_LABELS[d] });
	}
	for (const industry of filters.industries ?? []) {
		chips.push({ id: `industry:${industry}`, label: industry });
	}
	for (const b of BRANCH_ORDER) {
		if (filters.branches?.includes(b)) chips.push({ id: `branch:${b}`, label: b });
	}
	for (const bucket of LENGTH_BUCKETS) {
		if (bucket.durations.some((d) => filters.durations?.includes(d))) {
			chips.push({ id: `length:${bucket.label}`, label: bucket.label });
		}
	}
	for (const kind of filters.kinds ?? []) {
		chips.push({ id: `kind:${kind}`, label: KIND_LABELS[kind] });
	}
	return chips;
}

/** A list without `value`; an emptied list is dropped, since a key holding nothing means the same as none. */
function without<T>(list: readonly T[] | undefined, drop: (v: T) => boolean): T[] | undefined {
	const kept = (list ?? []).filter((v) => !drop(v));
	return kept.length > 0 ? kept : undefined;
}

/** The filters with one list replaced; an undefined or emptied value removes the key. */
export function withFilter<K extends keyof FinderFilters>(
	filters: FinderFilters,
	key: K,
	value: FinderFilters[K] | undefined
): FinderFilters {
	const next: FinderFilters = { ...filters };
	if (value === undefined) delete next[key];
	else next[key] = value;
	return next;
}

function dropPlace(setup: FinderSetup): FinderSetup {
	const next: FinderSetup = { ...setup };
	delete next.place;
	delete next.radius;
	return next;
}

/** The setup and filters with the chip's one choice taken away. */
export function removeChip(
	id: string,
	setup: FinderSetup,
	filters: FinderFilters
): { setup: FinderSetup; filters: FinderFilters } {
	if (id === 'place') return { setup: dropPlace(setup), filters };
	const sep = id.indexOf(':');
	const kind = id.slice(0, sep);
	const value = id.slice(sep + 1);
	let next = filters;
	if (kind === 'delivery') {
		next = withFilter(
			filters,
			'delivery',
			without(filters.delivery, (d) => String(d) === value)
		);
	} else if (kind === 'industry') {
		next = withFilter(
			filters,
			'industries',
			without(filters.industries, (i) => i === value)
		);
	} else if (kind === 'branch') {
		next = withFilter(
			filters,
			'branches',
			without(filters.branches, (b) => b === value)
		);
	} else if (kind === 'kind') {
		next = withFilter(
			filters,
			'kinds',
			without(filters.kinds, (k) => k === value)
		);
	} else if (kind === 'length') {
		const gone = LENGTH_BUCKETS.find((b) => b.label === value)?.durations ?? [];
		next = withFilter(
			filters,
			'durations',
			without(filters.durations, (d) => gone.includes(d))
		);
	}
	return { setup, filters: next };
}

/** Every choice taken away: the place and all the filters. */
export function clearAllChips(setup: FinderSetup): { setup: FinderSetup; filters: FinderFilters } {
	return { setup: dropPlace(setup), filters: {} };
}

/** The reach a person can widen to from where they are, or null when there is none wider. */
export function widerRadius(radius: FinderRadius | undefined): 100 | null {
	return radius === 25 || radius === 50 ? 100 : null;
}

/** The list with `value` switched on or off; an emptied list is dropped. */
export function toggled<T>(list: readonly T[] | undefined, value: T): T[] | undefined {
	const current = list ?? [];
	const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
	return next.length > 0 ? next : undefined;
}

/** Whether every duration of the bucket is chosen. */
export function bucketOn(
	durations: readonly Duration[] | undefined,
	bucket: readonly Duration[]
): boolean {
	return bucket.every((d) => durations?.includes(d));
}

/** The durations with the bucket switched: off when it was wholly on, otherwise on. */
export function toggledBucket(
	durations: readonly Duration[] | undefined,
	bucket: readonly Duration[]
): Duration[] | undefined {
	if (bucketOn(durations, bucket)) return without(durations, (d) => bucket.includes(d));
	return [...new Set([...(durations ?? []), ...bucket])];
}

/** How many of `rows` hold each value; rows come from the other filters, so a count is what ticking it would show. */
export function countBy<V>(
	rows: readonly { listing: Listing }[],
	values: readonly V[],
	has: (listing: Listing, value: V) => boolean
): Map<V, number> {
	return new Map(values.map((v) => [v, rows.filter((row) => has(row.listing, v)).length] as const));
}
