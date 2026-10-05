<script lang="ts">
	import { formatTimelineDate } from '$lib/timeline/format-date';
	import type { HandedOverEvent } from '$lib/calendar/types';

	let { events, onAcknowledge }: { events: HandedOverEvent[]; onAcknowledge: () => Promise<void> } =
		$props();

	// The earliest add these came from: the day the user last trusted their calendar to be current.
	const since = $derived(events.map((e) => e.addedOn).sort()[0]);
	// "Oct 3": the add day without its year; each listed event keeps its own full date.
	const sinceLabel = $derived(since ? formatTimelineDate(since).replace(/, \d{4}$/, '') : '');
	// One string, so the sentence reads exactly the same however the markup is wrapped.
	const lead = $derived(
		`Since you added it on ${sinceLabel}, these changed. Delete them from your calendar, then add again:`
	);
	let failed = $state(false);

	async function acknowledge(): Promise<void> {
		failed = false;
		try {
			await onAcknowledge();
		} catch {
			// Nothing was forgotten, so the list stays; say why the tap did not take.
			failed = true;
		}
	}
</script>

{#if events.length > 0}
	<div class="stale">
		<p class="stale__head">Your calendar is out of date</p>
		<p class="stale__lead">{lead}</p>
		<ul class="stale__list">
			{#each events as e (`${e.taskId}|${e.moment}|${e.isoDate}|${e.title}`)}
				<li>{e.title} <span class="stale__date">{formatTimelineDate(e.isoDate)}</span></li>
			{/each}
		</ul>
		<button class="stale__ack" type="button" onclick={() => void acknowledge()}
			>I've deleted these</button
		>
		{#if failed}<p class="stale__error" role="alert">
				Could not update right now - please try again.
			</p>{/if}
	</div>
{/if}

<style>
	/* Above the Add button: what to fix in the calendar before adding again. */
	.stale {
		border: 1px solid var(--color-accent-muted);
		border-radius: var(--radius-m);
		padding: var(--space-s) var(--space-m);
		margin-bottom: var(--space-m);
		font-size: var(--font-size-s);
	}
	.stale__head {
		margin: 0 0 var(--space-xs);
		font-weight: 700;
	}
	.stale__lead {
		margin: 0;
	}
	.stale__list {
		margin: var(--space-xs) 0;
		padding-left: var(--space-l);
	}
	.stale__date {
		color: var(--color-fg-muted);
	}
	.stale__ack {
		background: none;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		padding: var(--space-xs) var(--space-m);
		color: var(--color-accent);
		font: inherit;
		cursor: pointer;
	}
	.stale__error {
		margin: var(--space-s) 0 0;
		color: var(--color-fg-muted);
	}
</style>
