/**
 * Timeline generation engine - pure, IO-free, deterministic given its inputs.
 *
 * The pipeline: filter (persona gate) + anchor (EAOS projection), derive status, then
 * sort + group into the bucketed view.
 */

import { eaosOffsetDate, daysUntilSeparation, type EaosString } from '../profile/eaos';
import type { PersonaFilters, LeavingDates } from '../profile/persona';
import { PHASE_BUCKETS } from './task-defs';
import { addDays, daysBetween, localTodayIso } from './day-math';
import type { TaskDef, TaskKind, TimelineTaskState, TimelineState, PhaseBucket } from './types';

/** Why Fit pulled a window's last day in: the date the task must be finished before. */
export type FitReason = 'skillbridge' | 'terminal-leave';

/** A task definition projected onto absolute calendar dates off the user's EAOS. */
export type AnchoredTask = {
	def: TaskDef;
	sortOffset: number; // days from separation to the target date: the sort and phase key
	targetDate: string; // ISO: when to act - the recommended date, held inside a shortened window
	windowStartDate: string; // ISO: window opens (never moved by Fit)
	windowEndDate: string; // ISO: window closes - the day before the leaving day when Fit pulled it in
	finalEndDate?: string; // ISO: a two-edge task's final close
	separationDate: string; // ISO: the EAOS itself
	/** Present when Fit shortened the window: why, whether it still fits, and the official last day. */
	fit?: { reason: FitReason; cannotFit: boolean; officialEndDate: string };
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

/** The first day away a task must be finished before, and why; undefined when no entered date applies. */
function anchorFor(
	def: TaskDef,
	leaving: LeavingDates | undefined
): { date: string; reason: FitReason } | undefined {
	if (!leaving || def.finishBefore === 'separation') return undefined;
	const tl = leaving.terminalLeaveStart;
	if (def.finishBefore === 'terminal-leave') {
		return tl ? { date: tl, reason: 'terminal-leave' } : undefined;
	}
	const sb = leaving.skillbridgeStart;
	if (sb && (!tl || sb <= tl)) return { date: sb, reason: 'skillbridge' };
	return tl ? { date: tl, reason: 'terminal-leave' } : undefined;
}

/**
 * Anchor + Fit: project a def's day offsets to calendar dates off the EAOS. When the task must be finished before
 * a date the user leaves the command on, its last day becomes the earlier of the official last day and the day
 * before that date; its opening never moves, so every date still comes from the task's source. A window whose
 * opening falls after that last day cannot fit. A task whose rule counts from the leaving day moves its whole
 * window instead.
 */
function anchorTask(
	eaos: EaosString,
	def: TaskDef,
	leaving: LeavingDates | undefined
): AnchoredTask {
	const anchor = anchorFor(def, leaving);
	// A rule set as "N days before you leave" moves its whole window with the leaving day, so its last day is
	// already before that day and Fit leaves it alone.
	const from = def.countsFrom === 'leaving' ? anchor?.date : undefined;
	const at = (days: number) => (from ? addDays(from, days) : eaosOffsetDate(eaos, days));
	const separationDate = eaosOffsetDate(eaos, 0);
	const windowStartDate = at(def.windowStart);
	const officialEndDate = at(def.windowEnd);
	const lastDay = anchor ? addDays(anchor.date, -1) : undefined;
	const fitted = lastDay !== undefined && lastDay < officialEndDate;
	const windowEndDate = fitted ? lastDay : officialEndDate;
	const recommended = at(def.recommendedOffset ?? def.windowStart);
	const targetDate = recommended > windowEndDate ? windowEndDate : recommended;
	return {
		def,
		sortOffset: daysBetween(separationDate, targetDate),
		targetDate,
		windowStartDate,
		windowEndDate,
		...(def.finalEnd !== undefined ? { finalEndDate: eaosOffsetDate(eaos, def.finalEnd) } : {}),
		separationDate,
		...(fitted && anchor
			? {
					fit: {
						reason: anchor.reason,
						cannotFit: windowStartDate > windowEndDate,
						officialEndDate
					}
				}
			: {})
	};
}

/**
 * Filter the task set by the persona gate, then anchor each surviving task to the user's EAOS, fitting the tasks
 * that must be finished before a leaving date. A 'none' persona has no EAOS to anchor against -> empty list (the
 * route renders the setup CTA upstream). Pure + deterministic.
 */
export function filterAndAnchor(persona: PersonaFilters, defs: TaskDef[]): AnchoredTask[] {
	if (persona.completeness === 'none') return [];
	return defs
		.filter((def) => includeTask(persona, def))
		.map((def) => anchorTask(persona.eaos, def, persona.leaving));
}

/** Display status for a task card: paired with a text label in the view (never color-only). */
export type DisplayStatus =
	| 'upcoming'
	| 'start-now'
	| 'closing-soon'
	| 'late'
	| 'changed'
	| 'closed'
	| 'still-to-do'
	| 'done'
	| 'skipped'
	| 'snoozed'
	| 'after-you-leave';

/** A firm last day this close or closer reads "closing soon": the same distance as the first calendar alert. */
export const CLOSING_SOON_DAYS = 30;

/** States a snooze may never hide: a snooze quiets a task, it must not make anyone miss a deadline. */
export const FIRM_WARNINGS: ReadonlySet<DisplayStatus> = new Set([
	'closing-soon',
	'late',
	'changed',
	'closed'
]);

/**
 * Whether a status is a firm warning for this task: one a snooze cannot hide, and the card offers no Snooze for.
 * "After you leave" warns only on a firm task; a soft window is good timing only, so it stays calm and snoozable.
 */
export function isFirmWarning(status: DisplayStatus, kind: TaskKind): boolean {
	return FIRM_WARNINGS.has(status) || (status === 'after-you-leave' && kind !== 'soft');
}

/** The date-derived status, by the task's kind; stored done / skipped / snoozed are applied by the caller. */
function statusByDate(a: AnchoredTask, todayIso: string): DisplayStatus {
	if (a.fit?.cannotFit && todayIso <= a.separationDate) return 'after-you-leave';
	if (a.fit?.cannotFit) {
		return statusByDate({ ...a, windowEndDate: a.fit.officialEndDate, fit: undefined }, todayIso);
	}
	if (todayIso < a.windowStartDate) return 'upcoming';
	if (a.def.kind === 'soft') return todayIso > a.windowEndDate ? 'still-to-do' : 'start-now';
	if (todayIso <= a.windowEndDate) {
		return daysBetween(todayIso, a.windowEndDate) <= CLOSING_SOON_DAYS
			? 'closing-soon'
			: 'start-now';
	}
	// A required task before separation stays late until done; once separation has passed it can no longer be done.
	if (a.def.kind === 'required') {
		return todayIso > a.separationDate && a.windowEndDate < a.separationDate ? 'closed' : 'late';
	}
	if (a.finalEndDate !== undefined && todayIso <= a.finalEndDate) return 'changed';
	return 'closed';
}

/**
 * Derive a task's display status. Stored 'done' and 'skipped' win; a snooze still in the future quiets the task
 * unless the date says closing soon, late, changed or closed. Otherwise the status comes from the anchored window
 * and the task's kind. Today is the date on the device clock, so a window stays open through its last local day.
 */
export function deriveStatus(
	anchored: AnchoredTask,
	stored: TimelineTaskState | undefined,
	today: Date
): DisplayStatus {
	const todayIso = localTodayIso(today);
	if (stored?.status === 'done') return 'done';
	if (stored?.status === 'skipped') return 'skipped';
	const byDate = statusByDate(anchored, todayIso);
	const snoozed =
		stored?.status === 'snoozed' &&
		stored.snoozeUntil !== undefined &&
		stored.snoozeUntil > todayIso;
	return snoozed && !isFirmWarning(byDate, anchored.def.kind) ? 'snoozed' : byDate;
}

/** One generated, anchored, status-stamped task as rendered in the view. */
export type TimelineItem = {
	def: TaskDef;
	targetDate: string;
	windowStartDate: string;
	windowEndDate: string;
	status: DisplayStatus;
	finalEndDate?: string;
	daysLeft?: number; // days to the next firm edge while it counts down
	aimDate?: string; // soft tasks: the recommended date, or the window end once that passed
	snoozeUntil?: string; // ISO YYYY-MM-DD; present only while status === 'snoozed' (decision A)
	note?: string; // the user's saved note for this task, if any (shown on any status)
	/** Present when Fit pulled the last day in: why, and the date it moved to (the card names the reason there). */
	fit?: { reason: FitReason; date: string };
};

/** Per-phase progress tally derived from item display status (drives the header count + collapse). */
export type PhaseCounts = {
	done: number;
	skipped: number;
	snoozed: number;
	toDo: number; // active: every status but done / skipped / snoozed
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
				counts.toDo++; // every active status
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
	const todayIso = localTodayIso(today);

	const sorted = anchored
		.map((a) => {
			const stored = state.tasks[a.def.id];
			const status = deriveStatus(a, stored, today);
			// Once separation has passed, a task that could not fit is judged by its official window, so it shows that
			// window's last day rather than the pulled-in day before its own opening.
			const windowEndDate =
				a.fit?.cannotFit && todayIso > a.separationDate ? a.fit.officialEndDate : a.windowEndDate;
			// The countdown runs to the next firm edge: the last day while closing soon, the final edge between two.
			const nextEdge =
				status === 'closing-soon'
					? windowEndDate
					: status === 'changed'
						? a.finalEndDate
						: undefined;
			const item: TimelineItem = {
				def: a.def,
				targetDate: a.targetDate,
				windowStartDate: a.windowStartDate,
				windowEndDate,
				status,
				...(a.finalEndDate !== undefined ? { finalEndDate: a.finalEndDate } : {}),
				...(nextEdge !== undefined ? { daysLeft: daysBetween(todayIso, nextEdge) } : {}),
				...(a.def.kind === 'soft'
					? { aimDate: a.targetDate >= todayIso ? a.targetDate : windowEndDate }
					: {}),
				// snoozeUntil rides the view only while the item is actively snoozed; gating on the
				// derived status drops it for done/skipped and for expired (auto-reopened) snoozes.
				...(status === 'snoozed' && stored?.snoozeUntil !== undefined
					? { snoozeUntil: stored.snoozeUntil }
					: {}),
				...(stored?.notes !== undefined ? { note: stored.notes } : {}),
				...(a.fit && !a.fit.cannotFit
					? { fit: { reason: a.fit.reason, date: a.windowEndDate } }
					: {})
			};
			return { item, offset: a.sortOffset };
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
		view.todayDate = localTodayIso(today);
		view.daysToSeparation = daysToSep;
	}
	return view;
}
