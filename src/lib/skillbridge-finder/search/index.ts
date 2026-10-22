/**
 * Search over the listings already on the device. A listing is reduced to lower-case words (company, program,
 * roles, city, state, industry, military job codes) and a query is matched word by word, so nothing about what
 * a person types ever leaves the phone. The public O*NET military crosswalk lets a civilian word find a listing
 * that only names a military code, and a code find the same job under another branch's code.
 */

import type { Listing } from '../contract/listing';
import type { CrosswalkTable } from '../contract/tables';
import { STATE_NAMES } from './state-names';
import { withinOneEdit } from './typo';

/** A word must be at least this long to match the start of a longer word (search as you type). */
const MIN_PREFIX_LENGTH = 3;
/** A word must be at least this long to be forgiven one slip; shorter words would match too many others. */
const MIN_TYPO_LENGTH = 5;

export type SearchIndex = {
	/** Listing ids in the order the listings were given. */
	order: number[];
	/** Word -> ids of the listings that hold it. */
	postings: Map<string, Set<number>>;
	/** Every distinct word, for prefix and typo lookup. */
	words: string[];
	/** Military code (lower case) -> ids of listings that name it. */
	listingsByCode: Map<string, Set<number>>;
	/** Military code (lower case) -> O*NET codes it maps to. */
	onetsByCode: Map<string, Set<string>>;
	/** O*NET code -> military codes (lower case) that map to it. */
	codesByOnet: Map<string, Set<string>>;
};

/** Lower-case words split on anything that is not a letter or a digit; used for listings and queries alike. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0);
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
	const set = map.get(key);
	if (set) set.add(value);
	else map.set(key, new Set([value]));
}

export function buildSearchIndex(
	listings: readonly Listing[],
	crosswalk?: CrosswalkTable
): SearchIndex {
	const onetsByCode = new Map<string, Set<string>>();
	const codesByOnet = new Map<string, Set<string>>();
	const titlesByCode = new Map<string, Set<string>>();
	for (const [code, , onet, title] of crosswalk?.rows ?? []) {
		const key = code.toLowerCase();
		addTo(onetsByCode, key, onet);
		addTo(codesByOnet, onet, key);
		addTo(titlesByCode, key, title);
	}

	const postings = new Map<string, Set<number>>();
	const listingsByCode = new Map<string, Set<number>>();
	for (const listing of listings) {
		const texts = [
			listing.n,
			listing.p,
			...(listing.r ?? []),
			...(listing.c ? [listing.c] : []),
			...listing.ind
		];
		for (const state of [listing.s, ...(listing.ls ?? [])]) {
			if (state) texts.push(state, STATE_NAMES[state]);
		}
		if (Array.isArray(listing.oc)) {
			for (const code of listing.oc) {
				const key = code.toLowerCase();
				texts.push(code);
				addTo(listingsByCode, key, listing.i);
				texts.push(...(titlesByCode.get(key) ?? []));
			}
		}
		for (const text of texts) for (const word of tokenize(text)) addTo(postings, word, listing.i);
	}

	return {
		order: listings.map((l) => l.i),
		postings,
		words: [...postings.keys()],
		listingsByCode,
		onetsByCode,
		codesByOnet
	};
}

/** Ids of the listings that hold a word matching `word`: equal, a longer word it starts, or one slip away. */
function matchWord(index: SearchIndex, word: string): Set<number> {
	const hits = new Set<number>(index.postings.get(word));
	const addWord = (w: string) => index.postings.get(w)?.forEach((id) => hits.add(id));

	if (word.length >= MIN_PREFIX_LENGTH) {
		const forgiving = word.length >= MIN_TYPO_LENGTH;
		for (const w of index.words) {
			if (w.startsWith(word) || (forgiving && withinOneEdit(w, word))) addWord(w);
		}
	}

	// A military code also finds the same civilian job under any branch's code. Codes shared by several of its
	// O*NET jobs are gathered first, so the listings of each code are walked once.
	const related = new Set<string>();
	for (const onet of index.onetsByCode.get(word) ?? [])
		for (const code of index.codesByOnet.get(onet) ?? []) related.add(code);
	for (const code of related) index.listingsByCode.get(code)?.forEach((id) => hits.add(id));
	return hits;
}

/** Ids of the listings that match every word of the query, in the order the listings were given. */
export function search(index: SearchIndex, query: string): number[] {
	const words = tokenize(query);
	if (words.length === 0) return [...index.order];

	let matching: Set<number> | undefined;
	for (const word of words) {
		const hits = matchWord(index, word);
		matching = matching === undefined ? hits : new Set([...matching].filter((id) => hits.has(id)));
		if (matching.size === 0) return [];
	}
	const found = matching;
	return index.order.filter((id) => found?.has(id));
}
