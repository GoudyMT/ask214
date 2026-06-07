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

	// Phase header progress count (C4-4): active phases show what's left ("N to do", Format 1); a
	// fully-resolved phase shows the done/skipped breakdown. Derived from the engine's per-phase counts.
	function phaseCount(phase: TimelineView['phases'][number]): string {
		if (phase.collapsible) {
			const parts: string[] = [];
			if (phase.counts.done > 0) parts.push(`${phase.counts.done} done`);
			if (phase.counts.skipped > 0) parts.push(`${phase.counts.skipped} skipped`);
			return parts.join(' - ');
		}
		return `${phase.counts.toDo} to do`;
	}
</script>

<div class="timeline-list">
	{#each view.phases as phase (phase.bucket.id)}
		<section id={phase.bucket.id} aria-labelledby="{phase.bucket.id}-heading">
			<h2 id="{phase.bucket.id}-heading" class="timeline-list__phase">
				{phase.bucket.label} <span class="timeline-list__count">- {phaseCount(phase)}</span>
			</h2>
			{#each phase.items as item (item.def.id)}
				<TaskCard {item} {onSetStatus} {onSetSnooze} />
			{/each}
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

	/* The first phase sits flush under the route subline (no leading gap). */
	.timeline-list section:first-of-type .timeline-list__phase {
		margin-top: 0;
	}
</style>
