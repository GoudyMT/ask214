<script lang="ts">
	import { onMount } from 'svelte';
	import type { TimelineView } from '$lib/timeline';

	let { view }: { view: TimelineView } = $props();

	// One chip per non-empty phase (the engine already drops empty buckets). Each chip carries the
	// bucket's scroll-target id, a compact label (full label only as a fallback), and the total task
	// count in that phase - a stable "size of each phase" nav signal.
	const chips = $derived(
		view.phases.map((p) => ({
			id: p.bucket.id,
			label: p.bucket.shortLabel ?? p.bucket.label,
			count: p.items.length
		}))
	);

	let activeId = $state<string | null>(null);

	// Click a chip -> smooth-scroll to that phase's <section> (jump-to, NOT filter).
	// The sections are rendered by TimelineList (siblings in the route); we reach them by bucket id.
	function jumpTo(id: string): void {
		document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	// Scroll-spy: highlight the in-view phase as the user scrolls. Browser-only (IntersectionObserver);
	// the active-state is verified by the E2E, not the component test. Observes the section set
	// once at mount - the phase sections are stable for the session (status changes never remove items).
	onMount(() => {
		const sections = chips
			.map((c) => document.getElementById(c.id))
			.filter((el): el is HTMLElement => el !== null);
		if (sections.length === 0) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) activeId = entry.target.id;
				}
			},
			{ rootMargin: '-15% 0px -75% 0px', threshold: 0 }
		);
		for (const section of sections) observer.observe(section);
		return () => observer.disconnect();
	});
</script>

<nav class="phase-chips" aria-label="Jump to timeline phase">
	<ul class="phase-chips__strip">
		{#each chips as chip (chip.id)}
			<li>
				<button
					type="button"
					class="phase-chips__chip"
					class:phase-chips__chip--active={activeId === chip.id}
					onclick={() => jumpTo(chip.id)}
				>
					{chip.label} <span class="phase-chips__count">{chip.count}</span>
				</button>
			</li>
		{/each}
	</ul>
</nav>

<style>
	/* Sticky under the title, below the sticky header. The `top` offset clears the header height
	   (locked at the visual checkpoint). Opaque background so list content scrolls cleanly beneath. */
	.phase-chips {
		position: sticky;
		top: 3.5rem;
		z-index: 5;
		margin: 0 0 var(--space-m);
		padding: var(--space-s) 0;
		background: var(--color-bg);
		border-bottom: 1px solid var(--color-border);
	}

	/* On mobile the chips become one horizontally-scrolling row (no wrap, no wasted width). */
	.phase-chips__strip {
		display: flex;
		gap: var(--space-xs);
		margin: 0;
		padding: 0;
		list-style: none;
		overflow-x: auto;
	}

	/* Pill chip: muted by default, accent border + surface fill when it is the in-view phase. */
	.phase-chips__chip {
		white-space: nowrap;
		font-size: var(--font-size-s);
		padding: 4px 11px;
		border: 1px solid var(--color-border);
		border-radius: 999px;
		background: transparent;
		color: var(--color-fg-muted);
		cursor: pointer;
		touch-action: manipulation;
		-webkit-user-select: none;
		user-select: none;
		transition:
			color 120ms ease,
			border-color 120ms ease,
			background 120ms ease;
	}
	.phase-chips__chip:hover {
		color: var(--color-fg);
		border-color: var(--color-accent-muted);
	}
	.phase-chips__chip--active {
		background: var(--color-surface);
		color: var(--color-fg);
		border-color: var(--color-accent);
	}
	.phase-chips__count {
		margin-left: 2px;
	}
</style>
