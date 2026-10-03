<script lang="ts">
	import { formatTimelineDate } from '$lib/timeline/format-date';
	import type { TimelineItem } from '$lib/timeline';
	import type { NeedsNowGroups } from '$lib/timeline/needs-now';

	let { groups }: { groups: NeedsNowGroups } = $props();

	// The four groups in urgency order; an empty group is not drawn, and with all four empty the panel hides.
	const sections = $derived(
		[
			{ label: 'Late', items: groups.late },
			{ label: 'Closing soon', items: groups.closingSoon },
			{ label: 'Just closed', items: groups.justClosed },
			{ label: 'Just opened', items: groups.justOpened }
		].filter((s) => s.items.length > 0)
	);
	const total = $derived(sections.reduce((n, s) => n + s.items.length, 0));

	function when(item: TimelineItem): string {
		const f = formatTimelineDate;
		const days = item.daysLeft === 1 ? '1 day' : `${item.daysLeft} days`;
		switch (item.status) {
			case 'late':
				return `was due ${f(item.windowEndDate)}`;
			case 'closing-soon':
				return `${f(item.windowEndDate)} - ${days}`;
			case 'changed':
				return `${f(item.finalEndDate ?? item.windowEndDate)} - ${days}`;
			case 'closed':
				return `closed ${f(item.finalEndDate ?? item.windowEndDate)}`;
			default:
				return `open to ${f(item.windowEndDate)}`;
		}
	}
</script>

{#if total > 0}
	<section class="needs-now" aria-labelledby="needs-now-heading">
		<h2 id="needs-now-heading" class="needs-now__heading">
			Needs you now <span class="needs-now__count">{total}</span>
		</h2>
		{#each sections as section (section.label)}
			<h3 class="needs-now__group">{section.label}</h3>
			<ul class="needs-now__list">
				{#each section.items as item (item.def.id)}
					<li>
						<a class="needs-now__row" href="#task-{item.def.id}">
							<span class="needs-now__title">{item.def.title}</span>
							<span class="needs-now__when" class:needs-now__when--hot={item.status !== 'start-now'}
								>{when(item)}</span
							>
						</a>
					</li>
				{/each}
			</ul>
		{/each}
	</section>
{/if}

<style>
	/* A compact summary above the calendar card: danger-edged because everything in it is time-bound. */
	.needs-now {
		margin-bottom: var(--space-l);
		padding: var(--space-m);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-danger);
		border-radius: var(--radius-l);
	}
	.needs-now__heading {
		display: flex;
		justify-content: space-between;
		margin: 0;
		font-size: var(--font-size-base);
	}
	.needs-now__count {
		color: var(--color-fg-muted);
		font-weight: 400;
		font-size: var(--font-size-s);
	}
	.needs-now__group {
		margin: var(--space-s) 0 var(--space-xs);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.needs-now__list {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/* Each row is one link to its card; min-height keeps a 44px touch target. */
	.needs-now__row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-s);
		min-height: 44px;
		color: var(--color-fg);
		text-decoration: none;
		font-size: var(--font-size-s);
		border-bottom: 1px solid var(--color-border);
	}
	.needs-now__list li:last-child .needs-now__row {
		border-bottom: none;
	}
	.needs-now__row:hover .needs-now__title {
		text-decoration: underline;
	}
	.needs-now__when {
		flex: none;
		color: var(--color-fg-muted);
		white-space: nowrap;
	}
	.needs-now__when--hot {
		color: var(--color-danger);
		font-weight: 600;
	}
</style>
