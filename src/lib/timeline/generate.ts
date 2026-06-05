/**
 * Timeline generation engine - pure, IO-free, deterministic given its inputs.
 *
 * Accretes across Arc B: B3 = filter (TL-5 persona gate) + anchor (TL-3 EAOS projection);
 * B4 adds status derivation; B5 sorts + groups into the bucketed view.
 *
 * Source: Timeline Engine design spec (2026-06-03) section 5 "Generation Logic".
 */

import { eaosOffsetDate, type EaosString } from '../profile/eaos';
import type { PersonaFilters } from '../profile/persona';
import type { TaskDef } from './types';

/** A task definition projected onto absolute UTC calendar dates off the user's EAOS. */
export type AnchoredTask = {
	def: TaskDef;
	targetDate: string; // ISO YYYY-MM-DD: when to act (recommendedOffset, else windowStart)
	windowStartDate: string; // ISO: window opens
	windowEndDate: string; // ISO: window closes
};

/**
 * TL-5 persona gate. A task with no `requires` is universal. A gated task shows only when
 * every gate key is satisfied: the persona field must be SET (only the 'complete' persona
 * surfaces intendedPath/familyStatus) AND its value must be in the allowed list. Any
 * unsatisfied key hides the task - conservative, never show a task we cannot confirm applies.
 */
function includeTask(persona: PersonaFilters, def: TaskDef): boolean {
	const gate = def.requires;
	if (!gate) return true;

	if (gate.intendedPath) {
		if (persona.completeness !== 'complete') return false;
		if (!gate.intendedPath.includes(persona.intendedPath)) return false;
	}
	if (gate.familyStatus) {
		if (persona.completeness !== 'complete') return false;
		if (!gate.familyStatus.includes(persona.familyStatus)) return false;
	}
	return true;
}

/** TL-3 anchor: project a def's day offsets to absolute UTC dates off the EAOS. */
function anchorTask(eaos: EaosString, def: TaskDef): AnchoredTask {
	const recommended = def.recommendedOffset ?? def.windowStart;
	return {
		def,
		targetDate: eaosOffsetDate(eaos, recommended),
		windowStartDate: eaosOffsetDate(eaos, def.windowStart),
		windowEndDate: eaosOffsetDate(eaos, def.windowEnd)
	};
}

/**
 * Filter the task set by the persona gate (TL-5), then anchor each surviving task to the
 * user's EAOS (TL-3). A 'none' persona has no EAOS to anchor against -> empty list (the
 * route renders the setup CTA upstream). Pure + deterministic.
 */
export function filterAndAnchor(persona: PersonaFilters, defs: TaskDef[]): AnchoredTask[] {
	if (persona.completeness === 'none') return [];
	const eaos = persona.eaos;
	return defs.filter((def) => includeTask(persona, def)).map((def) => anchorTask(eaos, def));
}
