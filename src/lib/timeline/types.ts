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
