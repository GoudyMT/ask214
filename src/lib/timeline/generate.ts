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
import { PHASE_BUCKETS } from './task-defs';
import type { TaskDef, TimelineTaskState, TimelineState, PhaseBucket } from './types';

/** A task definition projected onto absolute UTC calendar dates off the user's EAOS. */
export type AnchoredTask = {
	def: TaskDef;
	effectiveOffset: number; // shifted sort/group key: (recommendedOffset ?? windowStart) - SkillBridge shift
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

/**
 * TL-3 anchor + TL-10 shift: project a def's day offsets to absolute UTC dates off the EAOS,
 * shifted earlier by `shiftDays` (the SkillBridge duration for military-track tasks; 0
 * otherwise). The shift is uniform across the target + both window edges, so the whole task
 * moves left as a unit.
 */
function anchorTask(eaos: EaosString, def: TaskDef, shiftDays: number): AnchoredTask {
	const effectiveOffset = (def.recommendedOffset ?? def.windowStart) - shiftDays;
	return {
		def,
		effectiveOffset,
		targetDate: eaosOffsetDate(eaos, effectiveOffset),
		windowStartDate: eaosOffsetDate(eaos, def.windowStart - shiftDays),
		windowEndDate: eaosOffsetDate(eaos, def.windowEnd - shiftDays)
	};
}

/**
 * Filter the task set by the persona gate (TL-5), then anchor each surviving task to the
 * user's EAOS (TL-3), left-shifting military-track tasks by the approved SkillBridge
 * duration (TL-10). A 'none' persona has no EAOS to anchor against -> empty list (the route
 * renders the setup CTA upstream). Pure + deterministic.
 */
export function filterAndAnchor(persona: PersonaFilters, defs: TaskDef[]): AnchoredTask[] {
	if (persona.completeness === 'none') return [];
	const eaos = persona.eaos;
	const skillbridge = persona.skillbridge;
	return defs
		.filter((def) => includeTask(persona, def))
		.map((def) => {
			const shiftDays =
				def.track === 'military' && skillbridge?.approved ? skillbridge.durationDays : 0;
			return anchorTask(eaos, def, shiftDays);
		});
}

/** Display status for a task card (TL-7): paired with a text label in the view (never color-only). */
export type DisplayStatus = 'upcoming' | 'start-now' | 'overdue' | 'done' | 'skipped' | 'snoozed';

/**
 * Derive a task's display status (TL-7). Stored terminal/deferred state wins: 'done' and
 * 'skipped' override the date; 'snoozed' holds only while snoozeUntil is still in the future
 * and otherwise auto-reopens (spec section 9). With no overriding stored state the status is
 * date-derived against the anchored window: before it opens = upcoming, inside = start-now,
 * past = overdue. Both ends are UTC ISO dates so time-of-day cannot shift the result (F-C-9).
 */
export function deriveStatus(
	anchored: AnchoredTask,
	stored: TimelineTaskState | undefined,
	today: Date
): DisplayStatus {
	const todayIso = today.toISOString().slice(0, 10);

	if (stored?.status === 'done') return 'done';
	if (stored?.status === 'skipped') return 'skipped';
	if (
		stored?.status === 'snoozed' &&
		stored.snoozeUntil !== undefined &&
		stored.snoozeUntil > todayIso
	) {
		return 'snoozed';
	}

	if (todayIso < anchored.windowStartDate) return 'upcoming';
	if (todayIso > anchored.windowEndDate) return 'overdue';
	return 'start-now';
}

/** One generated, anchored, status-stamped task as rendered in the view. */
export type TimelineItem = {
	def: TaskDef;
	targetDate: string;
	windowStartDate: string;
	windowEndDate: string;
	status: DisplayStatus;
};

/** A non-empty phase bucket with its (sorted) items and a count for the chip strip. */
export type TimelinePhase = {
	bucket: PhaseBucket;
	items: TimelineItem[];
	count: number;
};

/** The full generated timeline projection: ordered non-empty phases + a grand total. */
export type TimelineView = {
	phases: TimelinePhase[];
	total: number;
};

/**
 * Index of the PHASE_BUCKET that owns an offset. Buckets tile the runway contiguously as
 * half-open [startOffset, endOffset), so "the first bucket whose endOffset exceeds the
 * offset" is the containing bucket. An offset past the final bucket clamps to the last one
 * so an in-persona task is never silently dropped (the runway-edge case).
 */
function bucketIndexFor(offset: number): number {
	for (let i = 0; i < PHASE_BUCKETS.length; i++) {
		const bucket = PHASE_BUCKETS[i];
		if (bucket && offset < bucket.endOffset) return i;
	}
	return PHASE_BUCKETS.length - 1;
}

/**
 * Assemble the full timeline projection (spec section 5): filter (TL-5) + anchor (TL-3),
 * derive status (TL-7), sort furthest-out first (TL-6), group into PHASE_BUCKETS and drop
 * empty buckets (TL-9). A 'none' persona yields an empty view (the route shows the setup
 * CTA). Pure + deterministic; stores nothing.
 */
export function generateTimeline(
	persona: PersonaFilters,
	defs: TaskDef[],
	state: TimelineState,
	today: Date
): TimelineView {
	const anchored = filterAndAnchor(persona, defs);

	const sorted = anchored
		.map((a) => ({
			item: {
				def: a.def,
				targetDate: a.targetDate,
				windowStartDate: a.windowStartDate,
				windowEndDate: a.windowEndDate,
				status: deriveStatus(a, state.tasks[a.def.id], today)
			} satisfies TimelineItem,
			offset: a.effectiveOffset
		}))
		.sort((x, y) => x.offset - y.offset);

	const phases: TimelinePhase[] = [];
	for (let i = 0; i < PHASE_BUCKETS.length; i++) {
		const bucket = PHASE_BUCKETS[i];
		if (!bucket) continue;
		const items = sorted
			.filter((entry) => bucketIndexFor(entry.offset) === i)
			.map((entry) => entry.item);
		if (items.length === 0) continue;
		phases.push({ bucket, items, count: items.length });
	}

	return { phases, total: anchored.length };
}
