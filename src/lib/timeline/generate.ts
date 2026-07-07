/**
 * Timeline generation engine - pure, IO-free, deterministic given its inputs.
 *
 * The pipeline: filter (persona gate) + anchor (EAOS projection), derive status, then
 * sort + group into the bucketed view.
 */

import { eaosOffsetDate, daysUntilSeparation, type EaosString } from '../profile/eaos';
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
 * Persona gate. A task with no `requires` is universal. A gated task shows only when
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
 * Anchor + SkillBridge shift: project a def's day offsets to absolute UTC dates off the EAOS,
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
 * Filter the task set by the persona gate, then anchor each surviving task to the
 * user's EAOS, left-shifting military-track tasks by the approved SkillBridge
 * duration. A 'none' persona has no EAOS to anchor against -> empty list (the route
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

/** Display status for a task card: paired with a text label in the view (never color-only). */
export type DisplayStatus = 'upcoming' | 'start-now' | 'overdue' | 'done' | 'skipped' | 'snoozed';

/**
 * Derive a task's display status. Stored terminal/deferred state wins: 'done' and
 * 'skipped' override the date; 'snoozed' holds only while snoozeUntil is still in the future
 * and otherwise auto-reopens. With no overriding stored state the status is
 * date-derived against the anchored window: before it opens = upcoming, inside = start-now,
 * past = overdue. Both ends are UTC ISO dates so time-of-day cannot shift the result.
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
	snoozeUntil?: string; // ISO YYYY-MM-DD; present only while status === 'snoozed' (decision A)
	note?: string; // the user's saved note for this task, if any (shown on any status)
};

/** Per-phase progress tally derived from item display status (drives the header count + collapse). */
export type PhaseCounts = {
	done: number;
	skipped: number;
	snoozed: number;
	toDo: number; // active: upcoming + start-now + overdue
};

/** A non-empty phase bucket with its (sorted) items, a chip-strip count, a progress tally, and
 *  whether it is fully resolved (every task done or skipped -> collapsible). */
export type TimelinePhase = {
	bucket: PhaseBucket;
	items: TimelineItem[];
	count: number;
	counts: PhaseCounts;
	collapsible: boolean;
};

/** The full generated timeline projection: ordered non-empty phases + a grand total. */
export type TimelineView = {
	phases: TimelinePhase[];
	total: number;
	todayMarkerIndex?: number; // list index for the "Today" divider; absent for a none persona
	todayDate?: string; // ISO date the view was generated for (the Today marker's label)
	daysToSeparation?: number; // whole days from today to EAOS (the "X days left" count)
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

/** Tally a phase's items by display status (header progress count + the collapse decision). */
function tallyCounts(items: TimelineItem[]): PhaseCounts {
	const counts: PhaseCounts = { done: 0, skipped: 0, snoozed: 0, toDo: 0 };
	for (const item of items) {
		switch (item.status) {
			case 'done':
				counts.done++;
				break;
			case 'skipped':
				counts.skipped++;
				break;
			case 'snoozed':
				counts.snoozed++;
				break;
			default:
				counts.toDo++; // upcoming / start-now / overdue
		}
	}
	return counts;
}

/**
 * Index in the rendered phase list where the "Today" divider renders: before the first phase
 * that is NOT fully in the past (its endOffset is beyond today). Every phase past -> after the last
 * (phases.length). todayOffset = days from EAOS to today (negative = before separation), the same
 * sign convention as the bucket offsets.
 */
export function todayMarkerIndex(
	phases: readonly { bucket: { endOffset: number } }[],
	todayOffset: number
): number {
	const i = phases.findIndex((p) => p.bucket.endOffset > todayOffset);
	return i === -1 ? phases.length : i;
}

/**
 * Assemble the full timeline projection: filter + anchor,
 * derive status, sort furthest-out first, group into PHASE_BUCKETS and drop
 * empty buckets. A 'none' persona yields an empty view (the route shows the setup
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
		.map((a) => {
			const stored = state.tasks[a.def.id];
			const status = deriveStatus(a, stored, today);
			// snoozeUntil rides the view only while the item is actively snoozed; gating on the
			// derived status drops it for done/skipped and for expired (auto-reopened) snoozes.
			const item: TimelineItem = {
				def: a.def,
				targetDate: a.targetDate,
				windowStartDate: a.windowStartDate,
				windowEndDate: a.windowEndDate,
				status,
				...(status === 'snoozed' && stored?.snoozeUntil !== undefined
					? { snoozeUntil: stored.snoozeUntil }
					: {}),
				...(stored?.notes !== undefined ? { note: stored.notes } : {})
			};
			return { item, offset: a.effectiveOffset };
		})
		.sort((x, y) => x.offset - y.offset);

	const phases: TimelinePhase[] = [];
	for (let i = 0; i < PHASE_BUCKETS.length; i++) {
		const bucket = PHASE_BUCKETS[i];
		if (!bucket) continue;
		const items = sorted
			.filter((entry) => bucketIndexFor(entry.offset) === i)
			.map((entry) => entry.item);
		if (items.length === 0) continue;
		const counts = tallyCounts(items);
		// Collapsible only when every task is resolved as done/skipped - any snoozed (paused) or
		// active task keeps the phase open.
		const collapsible = counts.toDo === 0 && counts.snoozed === 0;
		phases.push({ bucket, items, count: items.length, counts, collapsible });
	}

	const view: TimelineView = { phases, total: anchored.length };
	if (persona.completeness !== 'none') {
		const daysToSep = daysUntilSeparation(persona.eaos, today);
		view.todayMarkerIndex = todayMarkerIndex(phases, -daysToSep);
		view.todayDate = today.toISOString().slice(0, 10);
		view.daysToSeparation = daysToSep;
	}
	return view;
}
