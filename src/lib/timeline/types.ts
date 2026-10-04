/**
 * Timeline domain types: the encrypted per-task state types, plus the task-definition
 * types (TaskDef, PersonaGate, TaskCategory, PhaseBucket) and the generated-view types.
 */

/** Terminal/deferred states the user sets explicitly. Absence of an entry = active. */
export type TaskStatus = 'done' | 'skipped' | 'snoozed';

/** Per-task user state. All fields optional; an absent task entry = untouched/active. */
export type TimelineTaskState = {
	status?: TaskStatus;
	snoozeUntil?: string; // ISO date (YYYY-MM-DD); only meaningful when status === 'snoozed'
	notes?: string;
};

/** The full encrypted timeline-state record (single self-row, id = 0). */
export type TimelineState = {
	schemaVersion: 1;
	tasks: Record<string, TimelineTaskState>;
};

/** v1.0 task categories (extensible). */
export type TaskCategory = 'medical' | 'admin' | 'benefits' | 'career' | 'finance';

/**
 * What a task must be finished before, from its source. 'separation': counted from separation alone - the two
 * leaving dates never move it. 'leaving': before the last day at the command, the day before the earlier of the
 * SkillBridge start and the terminal leave start (TAP must be complete before SkillBridge). 'terminal-leave':
 * before terminal leave only, so it may be done during SkillBridge (the separation health assessment). Required on
 * every task, so a new task cannot skip the choice.
 */
export type FinishBefore = 'separation' | 'leaving' | 'terminal-leave';

/**
 * How firm a task's window is. Required on every task, so a new task cannot skip the choice.
 * - soft: the window is good timing only; doing it later loses nothing but convenience.
 * - required: a firm date, but the task stays required after it (late, still required).
 * - closes: after the date the option is gone or works differently.
 */
export type TaskKind = 'soft' | 'required' | 'closes';

/**
 * Optional persona gate. No gate = universal (shows for everyone). A gated task shows
 * only when the persona field is SET and its value is in the list (hide-when-unset).
 * Extensible: v2.0 adds branch/component keys.
 */
export type PersonaGate = Partial<{
	intendedPath: string[];
	familyStatus: string[];
}>;

/**
 * A transition task definition (static content, versioned in the repo). Anchored to
 * the user's EAOS by day offsets (negative = before separation).
 */
export type TaskDef = {
	id: string; // stable slug; timeline-state + future peer-stories key off this
	title: string;
	category: TaskCategory;
	finishBefore: FinishBefore;
	windowStart: number; // days vs EAOS; negative = before separation
	windowEnd: number;
	kind: TaskKind;
	/** A second edge, days vs EAOS: the task changes at windowEnd and closes here (VGLI). */
	finalEnd?: number;
	/** One factual line shown once a firm date passes: what is still possible and where to go. */
	afterNote?: string;
	/** One factual line shown between a two-edge task's edges: what changed at the first. */
	changeNote?: string;
	recommendedOffset?: number; // defaults to windowStart
	why: string; // why it matters (plain language, 1-2 sentences)
	requires?: PersonaGate; // absent = universal
	calendar?: { allDay?: boolean; durationMin?: number }; // consumed by the later Calendar sub-project
};

/** A display phase bucket: [startOffset, endOffset) in days-from-EAOS (negative = before). */
export type PhaseBucket = {
	id: string;
	label: string;
	/** Compact label for the chip-strip nav (the full label is too long for a chip). */
	shortLabel?: string;
	startOffset: number;
	endOffset: number;
};
