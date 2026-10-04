<script lang="ts">
	import type { TimelineItem } from '$lib/timeline/generate';
	import type { TaskCategory } from '$lib/timeline/types';
	import type { TaskExclusions } from '$lib/calendar/types';
	import { buildIcs, type CalendarFile } from '$lib/calendar/build-ics';
	import { computeDesiredEvents } from '$lib/calendar/desired';
	import { currentDeviceHint } from '$lib/calendar/delivery';
	import { localTodayIso } from '$lib/timeline/day-math';

	type Props = {
		items: TimelineItem[];
		exclusions: TaskExclusions;
		/**
		 * Whether `exclusions` reflects the persisted record. FALSE while the store is unloaded or
		 * relocked, when the real exclusion set is UNKNOWN. Required (no default) so a caller cannot
		 * silently fail open: exporting against an unknown set would leak the categories the user
		 * deliberately kept off their calendar.
		 */
		ready: boolean;
		/** Receives an update to apply to the set as saved, not a whole new set; rejects when the save fails. */
		onSetExclusions: (update: (current: TaskExclusions) => TaskExclusions) => Promise<void>;
		/** Injected so the built file is testable and the actual hand-over stays the caller's concern. */
		onAdd: (file: CalendarFile) => void;
	};
	let { items, exclusions, ready, onSetExclusions, onAdd }: Props = $props();

	const CATEGORIES: TaskCategory[] = ['medical', 'admin', 'benefits', 'career', 'finance'];
	let building = $state(false);
	const hint = currentDeviceHint();
	// Category toggles live behind an inline expand - the same in-context idiom as the Timeline
	// snooze date-adjust, so the app keeps one consistent feel for tweaks (modals stay for the
	// wipe confirm + source reader).
	let expanded = $state(false);

	const hiddenCount = $derived(exclusions.categories.length);
	// The file carries only what is today or later, so with nothing ahead there is nothing to hand over.
	const hasEvents = $derived(
		computeDesiredEvents(items, exclusions, localTodayIso(new Date())).length > 0
	);

	let toggleError = $state<string | null>(null);

	// Applied to the set as saved, not to `exclusions`: that prop changes only once a save lands, so quick taps
	// would each start from the same older set and overwrite one another. A failed write puts the box back and
	// says so: the prop never changed, so the box would otherwise show a choice that was not saved.
	async function toggleCategory(
		cat: TaskCategory,
		on: boolean,
		box: HTMLInputElement
	): Promise<void> {
		toggleError = null;
		try {
			await onSetExclusions((current) => {
				const categories = current.categories.filter((c) => c !== cat);
				return { taskIds: current.taskIds, categories: on ? [...categories, cat] : categories };
			});
		} catch {
			box.checked = !on;
			toggleError = 'Could not update right now - please try again.';
		}
	}

	async function addToCalendar(): Promise<void> {
		building = true;
		try {
			onAdd(await buildIcs(items, exclusions, new Date()));
		} finally {
			building = false;
		}
	}
</script>

<section class="cal-section" aria-labelledby="calendar-heading">
	<h2 id="calendar-heading" class="cal-section__heading">Calendar</h2>
	<p class="cal-hint">Your upcoming deadlines, with alerts before each firm one.</p>

	<button
		class="cal-add"
		type="button"
		disabled={building || !ready || !hasEvents}
		onclick={() => void addToCalendar()}
	>
		Add to my calendar
	</button>
	{#if ready && !hasEvents}
		<p class="cal-hint cal-hint--device">Nothing ahead to add right now.</p>
	{:else}
		<p class="cal-hint cal-hint--device"><b>{hint.lead}</b> {hint.text}</p>
		<!-- Not every calendar app updates an event on a re-add, so the old ones are the user's to remove. -->
		<p class="cal-hint cal-hint--device">
			Changed a date? Remove the events you added before, then add again.
		</p>
	{/if}

	{#if !ready}
		<p class="cal-hint cal-hint--unavailable">
			Your calendar settings could not be loaded, so adding is unavailable right now. Reload the app
			to try again.
		</p>
	{/if}

	<div class="cal-customize">
		<button
			class="cal-customize__toggle"
			type="button"
			disabled={!ready}
			aria-expanded={expanded}
			aria-controls="cal-excl-list"
			onclick={() => (expanded = !expanded)}
		>
			<span class="cal-chevron" class:cal-chevron--open={expanded} aria-hidden="true"></span>
			<span>Customize what's included</span>
			<span class="cal-customize__summary">
				{!ready ? 'Unavailable' : hiddenCount === 0 ? 'All included' : `${hiddenCount} kept off`}
			</span>
		</button>

		{#if expanded}
			<fieldset id="cal-excl-list" class="cal-excl">
				<legend class="cal-excl__legend">Keep these off your calendar</legend>
				{#each CATEGORIES as cat (cat)}
					<label class="cal-excl__row">
						<input
							type="checkbox"
							value={cat}
							checked={exclusions.categories.includes(cat)}
							onchange={(e) => void toggleCategory(cat, e.currentTarget.checked, e.currentTarget)}
						/>
						<span>{cat}</span>
					</label>
				{/each}
			</fieldset>
			{#if toggleError}<p class="cal-hint" role="alert">{toggleError}</p>{/if}
		{/if}
	</div>
</section>

<style>
	.cal-section {
		margin-top: var(--space-l);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-l);
		padding: var(--space-l);
	}
	.cal-section__heading {
		margin: 0 0 var(--space-m);
	}
	.cal-hint {
		margin: 0 0 var(--space-m);
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.cal-add {
		padding: var(--space-s) var(--space-l);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.cal-add:hover {
		background: var(--color-accent-muted);
	}
	.cal-add:disabled {
		opacity: 0.6;
		cursor: default;
	}
	/* The sentence under the button: what this device does after the tap. */
	.cal-hint--device {
		margin: var(--space-s) 0 0;
	}
	.cal-hint b {
		color: var(--color-fg);
		font-weight: 600;
	}
	/* Shown only when the exclusion set is unknown - the export is refused rather than run against
	   defaults, so the user is told why instead of silently getting everything. */
	.cal-hint--unavailable {
		margin: var(--space-s) 0 0;
		color: var(--color-danger);
	}
	.cal-customize__toggle:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.cal-customize {
		margin-top: var(--space-l);
		padding-top: var(--space-m);
		border-top: 1px solid var(--color-border);
	}
	/* On a narrow phone the label wraps, each line starting at the left edge, while the summary keeps one
	   line - so the pair still reads as one row. */
	.cal-customize__toggle {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		width: 100%;
		padding: 0;
		background: none;
		border: none;
		color: var(--color-fg);
		font: inherit;
		font-size: var(--font-size-s);
		text-align: left;
		cursor: pointer;
	}
	.cal-customize__summary {
		margin-left: auto;
		color: var(--color-fg-muted);
		white-space: nowrap;
	}
	/* CSS caret (ASCII source, no glyph): a right-pointing triangle that rotates to point down when
	   open. No transition - the app's no-motion register. */
	.cal-chevron {
		width: 0;
		height: 0;
		border-left: 5px solid currentColor;
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		flex: none;
	}
	.cal-chevron--open {
		transform: rotate(90deg);
	}
	.cal-excl {
		margin: var(--space-m) 0 0;
		padding: 0;
		border: none;
	}
	.cal-excl__legend {
		padding: 0;
		color: var(--color-fg-muted);
		font-size: var(--font-size-s);
	}
	.cal-excl__row {
		display: flex;
		align-items: center;
		gap: var(--space-s);
		margin-top: var(--space-s);
		text-transform: capitalize;
	}
</style>
