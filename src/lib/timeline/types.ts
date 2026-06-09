/**
 * Timeline domain types. This file accretes across the build: A3 adds the encrypted
 * per-task state types; B1 adds the task-definition types (TaskDef, PersonaGate,
 * TaskCategory, PhaseBucket) and the generated-view types.
 *
 * Source: Timeline Engine design spec (2026-06-03) sections 4-6.
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
 * Which side of separation a task lives on. 'military' tasks must finish before the
 * member leaves for SkillBridge, so generation shifts them earlier by the approved
 * SkillBridge duration; 'transition' tasks anchor to the real EAOS (TL-10).
 */
export type TaskTrack = 'military' | 'transition';

/**
 * Optional persona gate. No gate = universal (shows for everyone). A gated task shows
 * only when the persona field is SET and its value is in the list (hide-when-unset,
 * TL-5). Extensible: v2.0 adds branch/component keys.
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
	track: TaskTrack;
	windowStart: number; // days vs EAOS; negative = before separation
	windowEnd: number;
	recommendedOffset?: number; // defaults to windowStart
	why: string; // why it matters (plain language, 1-2 sentences)
	value: string; // what the user gets from doing it
	sourceRef?: string; // citation into the corpus / outbound link (wires up later)
	requires?: PersonaGate; // absent = universal
	calendar?: { allDay?: boolean; durationMin?: number }; // consumed by the later Calendar sub-project
};

/** A display phase bucket: [startOffset, endOffset) in days-from-EAOS (negative = before). */
export type PhaseBucket = {
	id: string;
	label: string;
	/** Compact label for the C5 chip-strip nav (the full label is too long for a chip). */
	shortLabel?: string;
	startOffset: number;
	endOffset: number;
};
