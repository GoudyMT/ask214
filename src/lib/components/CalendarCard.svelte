<script lang="ts">
	import type { TimelineItem } from '$lib/timeline/generate';
	import type { TaskExclusions } from '$lib/calendar/types';
	import { buildIcs } from '$lib/calendar/build-ics';

	type Props = {
		items: TimelineItem[];
		exclusions: TaskExclusions;
		/** Injected so the serialized .ics is testable and the download stays the caller's concern. */
		onDownload: (ics: string) => void;
		onDismiss: () => void;
	};
	let { items, exclusions, onDownload, onDismiss }: Props = $props();

	let building = $state(false);

	// One tap = the calendar file, no chooser and no second screen. The exclusions the user set in
	// Settings are honoured here because both surfaces build from the same shared projection.
	async function add(): Promise<void> {
		building = true;
		try {
			onDownload(await buildIcs(items, exclusions, new Date()));
		} finally {
			building = false;
		}
	}
</script>

<section class="cal-card" aria-labelledby="cal-card-heading">
	<div class="cal-card__body">
		<h2 id="cal-card-heading" class="cal-card__heading">Keep your deadlines in sight</h2>
		<p class="cal-card__copy">Add your transition deadlines to the calendar you already check.</p>
		<button class="cal-card__add" type="button" disabled={building} onclick={() => void add()}>
			Add to my calendar
		</button>
	</div>
	<button class="cal-card__dismiss" type="button" aria-label="Dismiss" onclick={onDismiss}>
		<span aria-hidden="true">x</span>
	</button>
</section>

<style>
	/* Accent-bordered so it reads as an offer, not a warning (the danger register is reserved for
	   destructive surfaces). Static - no motion, per the brand register. */
	.cal-card {
		display: flex;
		align-items: flex-start;
		gap: var(--space-m);
		margin-bottom: var(--space-l);
		padding: var(--space-m);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-l);
	}
	.cal-card__body {
		flex: 1;
	}
	.cal-card__heading {
		margin: 0 0 var(--space-xs);
		font-size: var(--font-size-m, 1rem);
	}
	.cal-card__copy {
		margin: 0 0 var(--space-m);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.cal-card__add {
		padding: var(--space-s) var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		font-size: var(--font-size-s);
		cursor: pointer;
	}
	.cal-card__add:hover {
		background: var(--color-accent-muted);
	}
	.cal-card__add:disabled {
		opacity: 0.6;
		cursor: default;
	}
	/* Quiet dismiss: present but low-salience, so declining is easy without inviting a mis-tap. */
	.cal-card__dismiss {
		flex: none;
		padding: var(--space-xs) var(--space-s);
		background: none;
		border: none;
		color: var(--color-fg-muted);
		font: inherit;
		line-height: 1;
		cursor: pointer;
	}
	.cal-card__dismiss:hover {
		color: var(--color-fg);
	}
</style>
