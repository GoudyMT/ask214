<script lang="ts">
	import TaskCard from './TaskCard.svelte';
	import { formatTimelineDate } from '$lib/timeline/format-date';
	import type { TimelineView, TaskStatus } from '$lib/timeline';

	let {
		view,
		onSetStatus,
		onSetSnooze,
		onSetNote
	}: {
		view: TimelineView;
		onSetStatus: (taskId: string, status: TaskStatus | undefined) => void;
		onSetSnooze: (taskId: string, untilIso: string) => void;
		onSetNote?: (taskId: string, note: string | undefined) => void;
	} = $props();

	// Phase header progress count (C4-4): an open phase shows what's left = active + snoozed (Format 1
	// "N to do"; a snoozed task is paused, still pending - not done). A fully-resolved phase shows the
	// done/skipped breakdown. Derived from the engine's per-phase counts.
	function phaseCount(phase: TimelineView['phases'][number]): string {
		if (phase.collapsible) {
			const parts: string[] = [];
			if (phase.counts.done > 0) parts.push(`${phase.counts.done} done`);
			if (phase.counts.skipped > 0) parts.push(`${phase.counts.skipped} skipped`);
			return parts.join(' - ');
		}
		return `${phase.counts.toDo + phase.counts.snoozed} to do`;
	}

	// Per-phase ephemeral expand state (C4-4): a fully-resolved (collapsible) phase defaults to
	// collapsed; keyed by bucket id (absent = collapsed). Not persisted (spec section 7).
	let expanded = $state<Record<string, boolean>>({});

	// A phase that is no longer collapsible (e.g. a task was restored to active) drops its expand
	// state, so when it becomes fully resolved again it auto-collapses to the default - mirrors the
	// card-level reset (C4-4). Without this, a stale expanded=true would re-open it.
	$effect(() => {
		for (const phase of view.phases) {
			if (!phase.collapsible && expanded[phase.bucket.id]) {
				delete expanded[phase.bucket.id];
			}
		}
	});
</script>

{#snippet todayMarker(date: string, daysLeft: number | undefined)}
	<div class="timeline-today">
		<span class="timeline-today__pill"
			>Today - {formatTimelineDate(date)}{#if daysLeft !== undefined && daysLeft > 0}<span
					class="timeline-today__count">{daysLeft} days left</span
				>{/if}</span
		>
	</div>
{/snippet}

<div class="timeline-list">
	{#each view.phases as phase, i (phase.bucket.id)}
		{#if view.todayMarkerIndex === i && view.todayDate}
			{@render todayMarker(view.todayDate, view.daysToSeparation)}
		{/if}
		<section id={phase.bucket.id} aria-labelledby="{phase.bucket.id}-heading">
			{#if phase.collapsible}
				<h2 id="{phase.bucket.id}-heading" class="timeline-list__phase">
					<button
						type="button"
						class="timeline-list__toggle"
						aria-expanded={expanded[phase.bucket.id] ?? false}
						onclick={() => (expanded[phase.bucket.id] = !expanded[phase.bucket.id])}
					>
						<span
							class="timeline-list__caret"
							class:timeline-list__caret--right={!expanded[phase.bucket.id]}
							aria-hidden="true"
						></span>
						{phase.bucket.label}
						<span class="timeline-list__count">- {phaseCount(phase)}</span>
					</button>
				</h2>
				{#if expanded[phase.bucket.id]}
					{#each phase.items as item (item.def.id)}
						<TaskCard {item} {onSetStatus} {onSetSnooze} {onSetNote} />
					{/each}
				{/if}
			{:else}
				<h2 id="{phase.bucket.id}-heading" class="timeline-list__phase">
					{phase.bucket.label} <span class="timeline-list__count">- {phaseCount(phase)}</span>
				</h2>
				{#each phase.items as item (item.def.id)}
					<TaskCard {item} {onSetStatus} {onSetSnooze} {onSetNote} />
				{/each}
			{/if}
		</section>
	{/each}
	{#if view.todayMarkerIndex === view.phases.length && view.todayDate}
		{@render todayMarker(view.todayDate, view.daysToSeparation)}
	{/if}
</div>

<style>
	/* Phase section heading: semantically an <h2> (a labelled landmark for screen readers),
	   visually the mockup's small uppercase muted label so the cards stay the focus (spec
	   section 7). Overrides the global fluid h2. --font-size-s is the token floor (the mockup
	   used 12px; see the TaskCard sizing note). */
	.timeline-list__phase {
		margin: var(--space-l) 0 var(--space-s);
		font-size: var(--font-size-s);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-fg-muted);
	}

	/* Progress count appended to the phase label - normal case + weight so it reads as a quiet
	   sub-label rather than part of the uppercase heading (C4-4). */
	.timeline-list__count {
		text-transform: none;
		font-weight: 400;
	}

	/* Collapsible phase disclosure (C4-4): the header becomes a full-width toggle button inside the
	   <h2> (preserves the heading + aria-labelledby). Tap-safe like the task cards. */
	.timeline-list__toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-s);
		width: 100%;
		padding: 0;
		background: none;
		border: none;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
		touch-action: manipulation;
		-webkit-user-select: none;
		user-select: none;
	}

	/* Disclosure caret: down (default) when expanded, right when collapsed. */
	.timeline-list__caret {
		flex: none;
		width: 0;
		height: 0;
		border-left: 4px solid transparent;
		border-right: 4px solid transparent;
		border-top: 5px solid var(--color-fg-muted);
	}
	.timeline-list__caret--right {
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		border-left: 5px solid var(--color-fg-muted);
		border-right: none;
	}

	/* Jump-nav target offset (C5): a chip-strip jump lands the section below the sticky header +
	   chip strip. Tuned at the visual checkpoint. */
	.timeline-list section {
		scroll-margin-top: 6.5rem;
	}

	/* The first phase sits flush under the route subline (no leading gap). */
	.timeline-list section:first-of-type .timeline-list__phase {
		margin-top: 0;
	}
	/* Today marker (C5, T1): a centered accent pill on a hairline rule, rendered between the
	   fully-past phases and the current/upcoming ones (position from view.todayMarkerIndex). The
	   rule is decorative (pseudo-elements); the pill text marks today. */
	.timeline-today {
		display: flex;
		align-items: center;
		gap: var(--space-m);
		margin: var(--space-l) 0;
	}
	.timeline-today::before,
	.timeline-today::after {
		content: '';
		flex: 1;
		height: 1px;
		background: color-mix(in srgb, var(--color-accent) 35%, var(--color-border));
	}
	.timeline-today__pill {
		flex: none;
		font-size: var(--font-size-s);
		font-weight: 600;
		color: var(--color-accent);
		white-space: nowrap;
		background: color-mix(in srgb, var(--color-accent) 14%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-accent) 45%, transparent);
		border-radius: 999px;
		padding: 3px 12px;
	}

	/* Days-left count: muted text inside the "Today" pill (Option A - one unified capsule; shown
	   only when separation is in the future). The date leads in accent, the count is the quiet nudge. */
	.timeline-today__count {
		color: var(--color-fg-muted);
		font-weight: 400;
	}
	/* Separator dot in the same muted color as the count; symmetric margins (not content spaces)
	   keep the gaps even and immune to inline whitespace collapsing. */
	.timeline-today__count::before {
		content: '\00B7';
		margin: 0 0.4em;
	}
</style>
