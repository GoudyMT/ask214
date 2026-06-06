<script lang="ts">
	import TaskCard from './TaskCard.svelte';
	import type { TimelineView } from '$lib/timeline';

	let { view }: { view: TimelineView } = $props();
</script>

<div class="timeline-list">
	{#each view.phases as phase (phase.bucket.id)}
		<section id={phase.bucket.id} aria-labelledby="{phase.bucket.id}-heading">
			<h2 id="{phase.bucket.id}-heading" class="timeline-list__phase">{phase.bucket.label}</h2>
			{#each phase.items as item (item.def.id)}
				<TaskCard {item} />
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

	/* The first phase sits flush under the route subline (no leading gap). */
	.timeline-list section:first-of-type .timeline-list__phase {
		margin-top: 0;
	}
</style>
