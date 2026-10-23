import { STATE_CODES } from '../contract/places';
import type { ZipsTable } from '../contract/tables';
import { STATE_NAMES } from '../search/state-names';
import type { FinderPlace } from '../state/types';

/** What the setup field offers while a person types: a label to show and the place it stands for. */
export type PlaceSuggestion = { label: string; place: FinderPlace };

const MAX_SUGGESTIONS = 6;
const ZIP_RE = /^\d{5}$/;
const ZIP_LABEL_RE = /^(\d{5}) - /;

/** The field text for a place: a ZIP as its digits, a state by its name. */
export function placeText(place: FinderPlace): string {
	return place.kind === 'zip' ? place.zip : STATE_NAMES[place.state];
}

/**
 * The place a typed (or chosen) value names, or null. A ZIP is exactly five digits, alone or as a suggestion's label
 * ("21046 - Maryland"); a state is its full name or its two-letter code. Anything else names nothing, so no part of
 * free text ever becomes a place.
 */
export function parsePlaceText(text: string): FinderPlace | null {
	const value = text.trim();
	if (ZIP_RE.test(value)) return { kind: 'zip', zip: value };
	const labelled = ZIP_LABEL_RE.exec(value);
	if (labelled?.[1]) return { kind: 'zip', zip: labelled[1] };
	const lower = value.toLowerCase();
	for (const code of STATE_CODES) {
		if (code.toLowerCase() === lower || STATE_NAMES[code].toLowerCase() === lower) {
			return { kind: 'state', state: code };
		}
	}
	return null;
}

/** Suggestions for what has been typed so far: ZIPs by their start, states by the start of the name or the code. */
export function suggestPlaces(text: string, zips: ZipsTable | undefined): PlaceSuggestion[] {
	const value = text.trim();
	if (value === '') return [];
	if (/^\d{1,5}$/.test(value)) {
		const found: PlaceSuggestion[] = [];
		for (const [zip, state] of zips?.rows ?? []) {
			if (!zip.startsWith(value)) continue;
			found.push({ label: `${zip} - ${STATE_NAMES[state]}`, place: { kind: 'zip', zip } });
			if (found.length === MAX_SUGGESTIONS) break;
		}
		return found;
	}
	const lower = value.toLowerCase();
	return STATE_CODES.filter(
		(code) => STATE_NAMES[code].toLowerCase().startsWith(lower) || code.toLowerCase() === lower
	)
		.slice(0, MAX_SUGGESTIONS)
		.map((code) => ({ label: STATE_NAMES[code], place: { kind: 'state', state: code } }));
}
