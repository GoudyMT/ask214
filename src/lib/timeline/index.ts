/**
 * Public Timeline module API. The /timeline route + app-init consume the pure generation
 * engine, the static task seed, and the encrypted per-task state store through here.
 *
 * Generation is pure (no IO); the state store is the only stateful unit (spec section 3,
 * module decomposition). Internal generation helpers (filterAndAnchor / deriveStatus /
 * AnchoredTask) are intentionally NOT re-exported - the public surface is generateTimeline.
 *
 * Source: Timeline Engine design spec (2026-06-03).
 */
export { generateTimeline } from './generate';
export type { TimelineView, TimelinePhase, TimelineItem, DisplayStatus } from './generate';

export { TASK_DEFS, PHASE_BUCKETS } from './task-defs';

export { createTimelineStateStore } from './state.svelte';
export type {
	TimelineStateStore,
	TimelineStoreOptions,
	TimelineBroadcastEvent
} from './state.svelte';

export type {
	TaskDef,
	TaskCategory,
	TaskTrack,
	PersonaGate,
	PhaseBucket,
	TaskStatus,
	TimelineState,
	TimelineTaskState
} from './types';
