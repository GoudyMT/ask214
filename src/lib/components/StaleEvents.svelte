<script lang="ts">
	import { formatTimelineDate } from '$lib/timeline/format-date';
	import type { HandedOverEvent } from '$lib/calendar/types';
	import { handedOverKey } from '$lib/calendar/handed-over';

	let { events, onAcknowledge }: { events: HandedOverEvent[]; onAcknowledge: () => Promise<void> } =
		$props();
	// Ids for the heading and the lead, so the button's description can point at them; unique per instance.
	const uid = $props.id();

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
		<h3 id="{uid}-head" class="stale__head">Your calendar is out of date</h3>
		<p id="{uid}-lead" class="stale__lead">{lead}</p>
		<ul class="stale__list">
			<!-- Keyed by the identity the codec holds unique, so a stored list can never repeat a key here. -->
			{#each events as e (handedOverKey(e))}
				<li>{e.title} <span class="stale__date">{formatTimelineDate(e.isoDate)}</span></li>
			{/each}
		</ul>
		<button
			class="stale__ack"
			type="button"
			aria-describedby="{uid}-head {uid}-lead"
			onclick={() => void acknowledge()}>I've deleted these</button
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
	/* A heading for screen readers that looks as the box's bold first line did: the global h3 size, line height and
	   margins are set back to the box's own. */
	.stale__head {
		margin: 0 0 var(--space-xs);
		font-size: inherit;
		line-height: inherit;
		font-weight: 700;
	}
	.stale__lead {
		margin: 0;
	}
	.stale__list {
		margin: var(--space-xs) 0;
		padding-left: var(--space-l);
	}
	/* A date reads as one piece: when it does not fit after its title, the whole date takes the next line. */
	.stale__date {
		color: var(--color-fg-muted);
		white-space: nowrap;
	}
	/* min-height: the 44px touch target the Settings rows use. */
	.stale__ack {
		min-height: 44px;
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
