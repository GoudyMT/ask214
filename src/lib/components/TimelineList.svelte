<script lang="ts">
	import TaskCard from './TaskCard.svelte';
	import type { TimelineView, TaskStatus } from '$lib/timeline';

	let {
		view,
		onSetStatus,
		onSetSnooze
	}: {
		view: TimelineView;
		onSetStatus: (taskId: string, status: TaskStatus | undefined) => void;
		onSetSnooze: (taskId: string, untilIso: string) => void;
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
</script>

<div class="timeline-list">
	{#each view.phases as phase (phase.bucket.id)}
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
						<TaskCard {item} {onSetStatus} {onSetSnooze} />
					{/each}
				{/if}
			{:else}
				<h2 id="{phase.bucket.id}-heading" class="timeline-list__phase">
					{phase.bucket.label} <span class="timeline-list__count">- {phaseCount(phase)}</span>
				</h2>
				{#each phase.items as item (item.def.id)}
					<TaskCard {item} {onSetStatus} {onSetSnooze} />
				{/each}
			{/if}
		</section>
	{/each}
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

	/* The first phase sits flush under the route subline (no leading gap). */
	.timeline-list section:first-of-type .timeline-list__phase {
		margin-top: 0;
	}
</style>
