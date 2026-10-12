<script lang="ts">
	import { tick } from 'svelte';
	import type { TimelineItem } from '$lib/timeline/generate';
	import type { TaskExclusions } from '$lib/calendar/types';
	import { buildIcs, type CalendarFile } from '$lib/calendar/build-ics';
	import { currentDeviceHint, DELETE_FILE_HINT } from '$lib/calendar/delivery';

	type Props = {
		items: TimelineItem[];
		exclusions: TaskExclusions;
		/** Injected so the built file is testable and the hand-over stays the caller's concern. */
		onAdd: (file: CalendarFile) => void;
		onDismiss: () => void;
	};
	let { items, exclusions, onAdd, onDismiss }: Props = $props();

	let building = $state(false);
	const hint = currentDeviceHint();

	// One tap = the calendar file, no chooser and no second screen. The exclusions the user set in
	// Settings are honoured here because both surfaces build from the same shared projection.
	// A file that cannot be made says so: a tap that did nothing would read as a broken button. The next tap clears it.
	let addFailed = $state(false);

	async function add(button: HTMLButtonElement): Promise<void> {
		building = true;
		addFailed = false;
		let file: CalendarFile;
		try {
			file = await buildIcs(items, exclusions, new Date());
		} catch {
			addFailed = true;
			return;
		} finally {
			building = false;
			// Add was off while the file built, which dropped focus to the page; it gets it back unless the person moved on.
			void tick().then(() => document.activeElement === document.body && button.focus());
		}
		onAdd(file);
	}
</script>

<section class="cal-card" aria-labelledby="cal-card-heading">
	<div class="cal-card__body">
		<h2 id="cal-card-heading" class="cal-card__heading">Keep your deadlines in sight</h2>
		<p class="cal-card__copy">Your upcoming deadlines, with alerts before each firm one.</p>
		<button
			class="cal-card__add"
			type="button"
			disabled={building}
			onclick={(e) => void add(e.currentTarget)}
		>
			Add to my calendar
		</button>
		{#if addFailed}
			<p class="cal-card__error" role="alert">
				Could not make the calendar file right now - please try again.
			</p>
		{/if}
		<p class="cal-card__hint"><b>{hint.lead}</b> {hint.text}</p>
		<p class="cal-card__hint">{DELETE_FILE_HINT}</p>
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
	.cal-card__hint {
		margin: var(--space-s) 0 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	/* The file could not be made: right under the button that asked for it, in the danger colour. */
	.cal-card__error {
		margin: var(--space-s) 0 0;
		color: var(--color-danger);
		font-size: var(--font-size-s);
	}
	.cal-card__hint b {
		color: var(--color-fg);
		font-weight: 600;
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
